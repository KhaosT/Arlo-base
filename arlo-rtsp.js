'use strict';

const net = require('net');
const rtsp = require('rtsp-stream');
const ip = require('ip');

const inspect = require('util').inspect;

class ArloRTSPClient {
  constructor(address) {
    let self = this;

    self.address = address;
    self.port = 554;

    self.sanitizedURI = 'rtsp://' + self.address + '/live';

    self.requests = {};
    self.cseq = 1;

    self.keepAliveInterval = undefined;
    self.keepAliveIntervalMsecs = 5000; // 5s

    self.streamController = undefined;
    self.session = undefined;
    self.pendingReconnect = undefined;
  }

  updateStreamController(controller) {
    let self = this;

    self.streamController = controller;
  }

  prepareStream(request, callback) {
    console.log('prepare');
    let self = this;

    self.video_rtp = request.video.proxy_rtp;
    self.video_rtcp = request.video.proxy_rtcp;

    callback({
      video: {
        proxy_pt: 96,
        proxy_server_address: self.address,
        proxy_server_rtp: 11111, // Placeholder 
        proxy_server_rtcp: 12222 // Placeholder
      },
      audio: {
        port: 39012,
        ssrc: 2
      }
    });
  }

  handleStreamRequest(request) {
    console.log('stream request');
    let self = this;
    let requestType = request.type;

    if (requestType == 'start') {
      if (self.socket) {
        let videoConfig = request.video;
        let height = videoConfig.height;
        let bitrate = videoConfig.max_bit_rate;
        self.updateOptions(height, bitrate).then(() => {
          self.setup(self.video_rtp, self.video_rtcp).then((video) => {
            self.streamController.videoProxy.setServerRTPPort(video[0]);
            self.streamController.videoProxy.setServerRTCPPort(video[1]);
            self.play();
          });
        });
      } else {
        self.reconnect().then(() => {
          console.log('invoked2');
          let videoConfig = request.video;
          let height = videoConfig.height;
          let bitrate = videoConfig.max_bit_rate;
          self.updateOptions(height, bitrate).then(() => {
            console.log('invoked3');
            self.setup(self.video_rtp, self.video_rtcp).then((video) => {
              self.streamController.videoProxy.setServerRTPPort(video[0]);
              self.streamController.videoProxy.setServerRTCPPort(video[1]);
              self.play();
            });
          });
        });
      }
    } else if (requestType == 'stop') {
      self.teardown();
    }
  }

  reconnect() {
    let self = this;
    if (self.pendingReconnect) {
      return self.pendingReconnect;
    }

    self.pendingReconnect = new Promise((resolve, reject) => {
      self.decoder = new rtsp.Decoder();
      self.encoder = new rtsp.Encoder();

      self.socket = net.createConnection(self.port, self.address, function() {
        console.log('connected');
        self.pendingReconnect = undefined;
        resolve();
      });

      self.socket.on('error', (err) => {
        self.pendingReconnect = undefined;
        self.socket = undefined;

        console.log(err);
      });

      self.socket.pipe(self.decoder);
      self.encoder.pipe(self.socket);
      self.decoder.on('response', (response) => {
        self.onResponse(response);
      });

      self.decoder.on('error', (err) => {
        console.log(err);
      });
    });
    return self.pendingReconnect;
  }

  onResponse(response) {
    let self = this;
    let cseq = parseInt(response.headers['cseq']);
    let request = self.requests[cseq];
    if(!request)
      return;

    request.chunks = [];
    response.on('data', function(data) {
      request.chunks.push(data);
    });

    let done = function() {
      let requestOptions = request.options;
      let resolve = request.resolve;
      let reject = request.reject;

      delete self.requests[cseq];

      resolve({response: response, data: Buffer.concat(request.chunks)});
    };

    if(response.headers['session']) {
      let parts = response.headers['session'].split(';');
      self.newSession(parts[0]);
    }

    if(response.headers['content-length'] && parseInt(response.headers['content-length']) > 0)
      response.on('end', done);
    else
      done();
  }

  makeRequest(options) {
    return new Promise((resolve, reject) => {
      let self = this;
      let cseq = self.cseq++;

      if(!options.headers)
        options.headers = {};

      options.headers['CSeq'] = cseq;

      if(self.session && !options.headers['Session'])
        options.headers['Session'] = self.session;

      let request = self.encoder.request(options);
      self.requests[cseq] = {options: options, resolve: resolve, reject: reject};
      request.end();
    });
  }

  updateOptions(height, bitrate) {
    let self = this;

    return self.makeRequest({
      method: 'OPTIONS',
      uri: self.sanitizedURI,
      headers: {
        'NTGR_MaxResolution': height + 'p',
        'NTGR_RequestedBitrate': bitrate,
        'NTGR_ActiveSendTime': 10,
        'NTGR_ActiveSendTimeOffset': 0,
        'NTGR_StreamType': 'USER'
      }
    });
  }

  setup(rtpPort, rtcpPort) {
    let self = this;

    return self.makeRequest({
      method: 'SETUP',
      uri: self.sanitizedURI,
      headers: {
        'Transport': 'RTP/AVP;unicast;client_port=' + rtpPort.toString() + '-' + rtcpPort.toString()
      }
    }).then(result => {
      let response = result.response;
      let data = result.data;

      let transport = response.headers['transport'];
      if(!transport)
        return Promise.reject({ message: 'No transport.', response: response });

      let rtpPort = null;
      let rtcpPort = null;

      for(let value of transport.split(';')) {
        let parts = value.split('=', 2);
        if(parts.length != 2)
          continue;

        if(parts[0] == 'server_port') {
          let ports = parts[1].split('-', 2);
          rtpPort = parseInt(ports[0]);
          if(ports.length == 2)
            rtcpPort = parseInt(ports[1]);
          else
            rtcpPort = rtpPort;
        }
      }

      if(rtpPort && rtcpPort) {
        return [rtpPort, rtcpPort];
      } else {
        return Promise.reject({ message: 'Could not parse transport.', transport: transport, rtpPort: rtpPort, rtcpPort: rtcpPort });
      }
    });
  }

  play() {
    let self = this;
    return self.makeRequest({
      method: 'PLAY',
      uri: self.sanitizedURI
    });
  }

  pause() {
    let self = this;
    return self.makeRequest({
      method: 'PAUSE',
      uri: self.sanitizedURI
    });
  }

  teardown() {
    let self = this;
    let promise = self.makeRequest({
      method: 'TEARDOWN',
      uri: self.sanitizedURI,
      headers: {
        'Session': self.session
      }
    });

    self.closeSession();
    return promise;
  }

  ping() {
    let self = this;
    return self.makeRequest({
      method: 'OPTIONS',
      uri: self.sanitizedURI
    });
  }

  newSession(session) {
    let self = this;
    self.session = session;
    if (self.keepAliveInterval) {
      clearInterval(self.keepAliveInterval);
    }

    self.keepAliveInterval = setInterval(function() {
      self.ping().catch((err) => {
        self.emit(err);
      });
    }, self.keepAliveIntervalMsecs);
  }

  closeSession() {
    let self = this;
    self.session = undefined;
    if (self.keepAliveInterval) {
      clearInterval(self.keepAliveInterval);
    }

    if (self.socket) {
      self.socket.end();
      self.socket = undefined;
    }
  }
}

module.exports = ArloRTSPClient;