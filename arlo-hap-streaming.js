'use strict';

const uuid = require('hap-nodejs').uuid;
const Accessory = require('hap-nodejs').Accessory;
const Service = require('hap-nodejs').Service;
const Characteristic = require('hap-nodejs').Characteristic;
const StreamController = require('hap-nodejs').StreamController;
const RTSPClient = require('./arlo-rtsp');

class ArloStreamSource {
  constructor(accessory, address) {
    let self = this;

    self.accessory = accessory;

    let availableResolutions = [
      [1280, 720, 30],
      [1280, 720, 15],
      [640, 360, 30],
      [640, 360, 15],
      [320, 240, 30],
      [320, 240, 15]
    ];

    let audioSettings = {
      codecs: [
        {
          type: 'OPUS',
          samplerate: 16
        }
      ]
    };

    let videoCodec = {
      profiles: [StreamController.VideoCodecParamProfileIDTypes.MAIN],
      levels: [StreamController.VideoCodecParamLevelTypes.TYPE4_0]
    };

    let options = {
      proxy: true,
      disable_audio_proxy: true,
      srtp: false,
      video: {
        resolutions: availableResolutions,
        codec: videoCodec
      },
      audio: audioSettings
    };

    self.services = [];
    self.streamControllers = [];
    self.rtspClient = new RTSPClient(address);

    self._createCameraControlService();
    self._createStreamControllers(options);
  }

  handleSnapshotRequest(request, callback) {
    let self = this;

    self.accessory.requestSnapshot((data) => {
      callback(undefined, data);
    })
  }

  handleCloseConnection(connectionID) {
    let self = this;
    self.streamControllers.forEach(function(controller) {
      controller.handleCloseConnection(connectionID);
    });
  }

  _createCameraControlService() {
    let self = this;

    let controlService = new Service.CameraControl();

    controlService.getCharacteristic(Characteristic.NightVision).on('set', (value, callback) => {
      self.accessory.updateNightVision(value, () => {
        callback();
      })
    });

    controlService.getCharacteristic(Characteristic.ImageMirroring).on('set', (value, callback) => {
      self.accessory.updateVideoMirror(value, () => {
        callback();
      })
    })

    self.services.push(controlService);
  }

  _createStreamControllers(options) {
    let self = this;
    let streamController = new StreamController(1, options, self.rtspClient);
    self.rtspClient.updateStreamController(streamController);

    self.services.push(streamController.service);
    self.streamControllers.push(streamController);
  }
}

module.exports = ArloStreamSource;