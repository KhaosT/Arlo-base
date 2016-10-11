'use strict';

const net = require('net');
const http = require('http');

const ip = require('ip');
const uuid = require('node-uuid');

const dhcpd = require('./dhcpd');
const camera = require('./arlo-accessory');

const debug = require('debug')('Arlo');

class Arlo {
  constructor(opts) {
    let self = this;
    self.opts = opts;

    self.messageID = 1;

    self.cameras = {};
    self.pendingSnapshots = {};

    self.snapshotServer = http.createServer(self.handleSnapshotRequest.bind(self));
    self.snapshotServer.listen(0, function() {
      debug('Snapshot server listening on port: %s', self.snapshotServer.address().port);
    });

    self.server = net.createServer((c) => {
      c.on('data', (data) => {
        self.handleClientRequest(c, data);
      });
    })

    self.server.on('error', (err) => {
      debug(err);
    });

    self.server.listen(4000, () => {
      debug('Arlo listening on port 4000.');
    });

    var leases = {};

    opts.cameras.forEach((camera) => {
      leases[camera.mac] = camera.address;
    });

    let currentAddress = ip.address();

    self.dhcp_server = new dhcpd({
      host: currentAddress,
      subnet: opts.subnet,
      routers: [currentAddress],
      leases: leases
    });
  }

  sendMessage(host, body) {
    let self = this;

    let connection = net.connect({
      host: host,
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

      connection.end();
    });

    connection.on('error', (error) => {
      debug('base err');
      debug(error);
    });
  }

  requestSnapshot(host, callback) {
    let self = this;

    let connection = net.connect({
      host: host,
      port: 4000
    }, () => {
      let requestKey = '/' + uuid.v4();
      let request = {
        Type: 'fullSnapshot',
        ID: 2,
        DestinationURL: 'http://' + connection.localAddress + ':' + self.snapshotServer.address().port + requestKey + '/temp.jpg'
      };

      self.pendingSnapshots[requestKey + '/'] = callback;

      let requestPayload = JSON.stringify(request);
      let reqMessage = 'L:'+requestPayload.length+' '+requestPayload;
      connection.write(reqMessage);
    });

    connection.on('data', (data) => {
      connection.end();
    });

    connection.on('error', (error) => {
      debug('snapshot err');
      debug(error);
      if (error.code == 'ECONNRESET') {
        setTimeout(() => {
          self.requestSnapshot(host, callback);
        }, 300);
      }
    });
  }

  handleSnapshotRequest(request, response) {
    let self = this;

    if (request.url && self.pendingSnapshots[request.url]) {
      var requestData = Buffer(0);
      request.on('data', (data) => { requestData = Buffer.concat([requestData, data]); });
      request.on('end', () => {
        let startIndex = requestData.indexOf('\r\n\r\n');
        let endIndex = requestData.indexOf('--------------------', startIndex);
        let snapshotImage = requestData.slice(startIndex + 4, endIndex);

        self.pendingSnapshots[request.url](snapshotImage);
        delete self.pendingSnapshots[request.url];

        response.end('<html><body>The upload has been completed.</body></html>');
      });
    } else {
      response.end('<html><body>The upload has been completed.</body></html>');
    }
  }

  handleClientRequest(connection, data) {
    let self = this;

    if (data) {
      let startIndex = data.indexOf(' ');
      if (startIndex < 0) {
        connection.end();
        return;
      }

      let rawRequest = data.slice(startIndex + 1);
      let request = JSON.parse(rawRequest);

      let response = {
        Type: 'response',
        ID: request.ID,
        Response: 'Ack'
      };

      let responsePayload = JSON.stringify(response);
      let replyMessage = 'L:'+responsePayload.length+' '+responsePayload;
      connection.write(replyMessage);

      if (request.Type == 'registration') {
        var existingCamera = self.cameras[connection.remoteAddress];

        if (!existingCamera) {
          var name = "Unknown";
          var address = connection.remoteAddress;
          var macAddress;

          for (let key in self.opts.cameras) {
            let cameraInfo = self.opts.cameras[key];
            if (ip.isEqual(cameraInfo.address, connection.remoteAddress)) {
              name = cameraInfo.name;
              address = cameraInfo.address;
              macAddress = cameraInfo.mac;
              break;
            }
          }

          if (!macAddress) {
            return;
          }

          existingCamera = new camera(self, address, name, macAddress, request);
          self.cameras[connection.remoteAddress] = existingCamera;
        } else {
          existingCamera.handleDeviceRegistration(request);
        }
      } else {
        var existingCamera = self.cameras[connection.remoteAddress];
        if (existingCamera) {
          existingCamera.handleRequest(request);
        } else {
          // We don't have the record of the device.
          console.log('Received request from unknown Arlo: %s', connection.remoteAddress);
        }
      }
    }
  }
}

module.exports = Arlo;