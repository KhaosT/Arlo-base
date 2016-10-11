'use strict';

const uuid = require('hap-nodejs').uuid;
const Accessory = require('hap-nodejs').Accessory;
const Service = require('hap-nodejs').Service;
const Characteristic = require('hap-nodejs').Characteristic;

const ArloStreamSource = require('./arlo-hap-streaming');

const net = require('net');
const debug = require('debug')('ArloAccessory');

class ArloAccessory {
  constructor(base, address, name, macAddress, info) {
    console.log('new camera: %s - %s', address, name);
    let self = this;

    if (info.CommProtocolVersion != 1) {
      console.log('Unexpected protocol version. Things may not work as expected.');
    }

    self._base = base;
    self._address = address;
    self._macAddress = macAddress;

    self._pendingSnapshotRequests = [];

    self.name = name;
    self.messageID = 1;

    self.handleDeviceRegistration(info);
    self.updateCameraSettings(() => {
      self.requestStatusUpdate();
    });

    self.setupAccessory();
  }

  setupAccessory() {
    let self = this;

    self.accessory = new Accessory(self.name, uuid.generate(self.serialNumber));

    self.accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Netgear')
      .setCharacteristic(Characteristic.Model, self.modelNumber)
      .setCharacteristic(Characteristic.SerialNumber, self.serialNumber)
      .setCharacteristic(Characteristic.FirmwareRevision, self.firmwareVersion)
      .setCharacteristic(Characteristic.HardwareRevision, self.hardwareRev);

    // Battery Service
    self.batteryService = self.accessory.addService(Service.BatteryService);
    self.lowBatteryChar = self.batteryService.getCharacteristic(Characteristic.StatusLowBattery);
    self.batteryLevelChar = self.batteryService.getCharacteristic(Characteristic.BatteryLevel);
    self.batteryService.getCharacteristic(Characteristic.ChargingState).setProps({
      maxValue: 2
    }).setValue(Characteristic.ChargingState.NOT_CHARGEABLE);
    self.updateBatteryStatus();

    // Security Service
    self.securityService = self.accessory.addService(Service.SecuritySystem, 'Security');
    self.currentSecurityStateChar = self.securityService.getCharacteristic(Characteristic.SecuritySystemCurrentState);
    self.targetSecurityStateChar = self.securityService.getCharacteristic(Characteristic.SecuritySystemTargetState);

    self.currentSecurityStateChar.setValue(Characteristic.SecuritySystemCurrentState.DISARMED);
    self.targetSecurityStateChar.setValue(Characteristic.SecuritySystemTargetState.DISARM);
    self.targetSecurityStateChar.on('set', self.handleUpdateSecurityState.bind(self));

    // Motion Service
    self.motionDetected = false;
    self.motionService = self.accessory.addService(Service.MotionSensor, 'Motion');
    self.motionDetectedChar = self.motionService.getCharacteristic(Characteristic.MotionDetected);

    self.streamSource = new ArloStreamSource(self, self._address);
    self.accessory.configureCameraSource(self.streamSource);

    self.accessory.publish({
      username: self._macAddress.toUpperCase(),
      pincode: "031-45-154",
      category: Accessory.Categories.CAMERA
    });
  }

  handleDeviceRegistration(info) {
    let self = this;

    self.serialNumber = info.SystemSerialNumber;
    self.modelNumber = info.SystemModelNumber;
    self.hardwareRev = info.HardwareRevision;
    self.firmwareVersion = info.SystemFirmwareVersion;

    self.batteryPercentage = info.BatteryPercentage;
    self.batteryLevel = info.BatteryBars;
    self.signalStrength = info.SignalStrengthIndicator;
  }

  handleRequest(request) {
    let self = this;

    if (request.Type == 'status') {
      self.handleStatus(request);
    } else if (request.Type == 'alert') {
      self.handleAlert(request);
    } else {
      // Unknown Type
      let date = new Date();
      console.log(date.toLocaleString() + '\n' + JSON.stringify(request));
    }
  }

  handleStatus(request) {
    let self = this;

    self.temperature = request.Temperature;
    self.batteryPercentage = request.BatteryPercentage;

    self.updateBatteryStatus();
  }

  handleAlert(request) {
    let self = this;

    if (request.AlertType == 'pirMotionAlert') {
      let motionDetail = request.PIRMotion;
      if (motionDetail.Triggered == true && !self.motionDetected) {
        self.motionDetected = true;

        self.motionDetectedChar.updateValue(true);
        setTimeout(function() {
          self.motionDetected = false;
          self.motionDetectedChar.updateValue(false);
        }, 10000);

        return;
      }
    }

    // Print out unhandled request
    let date = new Date();
    debug(date.toLocaleString() + '\n' + JSON.stringify(request));
  }

  updateBatteryStatus() {
    let self = this;

    if (self.batteryService) {
      self.batteryLevelChar.setValue(self.batteryPercentage);

      if (self.batteryPercentage <= 20) {
        self.lowBatteryChar.setValue(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
      } else {
        self.lowBatteryChar.setValue(Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      }
    }
  }

  requestStatusUpdate() {
    let self = this;
    self.sendMessage({
      Type: 'statusRequest',
      ID: 1
    });
  }

  requestSnapshot(callback) {
    let self = this;

    self._pendingSnapshotRequests.push(callback);

    if (self._pendingSnapshotRequests.length == 1) {
      self._base.requestSnapshot(self._address, (data) => {
        self._pendingSnapshotRequests.forEach((handler) => {
          handler(data);
        });
        self._pendingSnapshotRequests = [];
      });
    }
  }

  updateCameraSettings(callback) {
    let self = this;

    let request = {
      Type: 'registerSet',
      ID: 1,
      SetValues: {
        VideoExposureCompensation: 0,
        VideoMirror: false,
        VideoFlip: false,
        VideoWindowStartX: 0,
        VideoWindowStartY: 0,
        VideoWindowEndX: 1280,
        VideoWindowEndY: 720,
        VideoOutputResolution: '360p',
        VideoTargetBitrate: 300,
        MaxMissedBeaconTime: 10,
        MaxStreamTimeLimit: 1800,
        MaxUserStreamTimeLimit: 1800,
        VideoAntiFlickerRate: 60,
        WifiCountryCode: 'US',
        NightVisionMode: false
      }
    };

    self.sendMessage(request, callback);
  }

  updatePIRState(state, sensitivity, callback) {
    let self = this;

    var requestBody = {
      PIRTargetState: state
    };

    if (state == 'Armed') {
      requestBody.PIRStartSensitivity = sensitivity;
      requestBody.PIRAction = 'Report Only';
      requestBody.VideoMotionEstimationEnable = false;
    }

    let request = {
      Type: 'registerSet',
      ID: 1,
      SetValues: requestBody
    }

    self.sendMessage(request, callback);
  }

  updateNightVision(enable, callback) {
    let self = this;

    let request = {
      Type: 'registerSet',
      ID: 1,
      SetValues: {
        NightVisionMode: enable
      }
    };

    self.sendMessage(request, () => {
      callback();
    });
  }

  updateVideoMirror(enable, callback) {
    let self = this;

    let request = {
      Type: 'registerSet',
      ID: 1,
      SetValues: {
        VideoMirror: enable
      }
    };

    self.sendMessage(request, () => {
      callback();
    });
  }

  updateVideoFlip(enable, callback) {
    let self = this;

    let request = {
      Type: 'registerSet',
      ID: 1,
      SetValues: {
        VideoFlip: enable
      }
    };

    self.sendMessage(request, () => {
      callback();
    });
  }

  sendMessage(body, callback) {
    let self = this;

    let connection = net.connect({
      host: self._address,
      port: 4000
    }, () => {
      body.ID = self.messageID++;

      let requestPayload = JSON.stringify(body);
      let reqMessage = 'L:'+requestPayload.length+' '+requestPayload;
      connection.write(reqMessage);
    });

    connection.on('data', (data) => {
      let startIndex = data.indexOf(' ');
      if (startIndex < 0) {
        connection.end();
        return;
      }

      let responseData = data.slice(startIndex + 1);
      let response = JSON.parse(responseData);
      
      if (response && response.Response != 'Ack') {
        debug('arlo response: %s', data);
      }

      if (callback) {
        callback(response);
      }

      connection.end();
    });

    connection.on('error', (error) => {
      debug('conn err');
      debug(error);
    });
  }

  handleUpdateSecurityState(value, callback) {
    let self = this;

    if (value == Characteristic.SecuritySystemTargetState.STAY_ARM) {
      self.updatePIRState('Armed', 40, (response) => {
        callback();
        self.currentSecurityStateChar.updateValue(Characteristic.SecuritySystemCurrentState.STAY_ARM);
      });
    } else if (value == Characteristic.SecuritySystemTargetState.AWAY_ARM) {
      self.updatePIRState('Armed', 80, (response) => {
        callback();
        self.currentSecurityStateChar.updateValue(Characteristic.SecuritySystemCurrentState.AWAY_ARM);
      });
    } else if (value == Characteristic.SecuritySystemTargetState.NIGHT_ARM) {
      self.updatePIRState('Armed', 60, (response) => {
        callback();
        self.currentSecurityStateChar.updateValue(Characteristic.SecuritySystemCurrentState.NIGHT_ARM);
      });
    } else if (value == Characteristic.SecuritySystemTargetState.DISARM) {
      self.updatePIRState('Disarmed', 0, (response) => {
        callback();
        self.currentSecurityStateChar.updateValue(Characteristic.SecuritySystemCurrentState.DISARMED);
      });
    } else {
      callback();
    }
  }
}

module.exports = ArloAccessory;