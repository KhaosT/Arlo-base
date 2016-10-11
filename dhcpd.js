'use strict';

const dhcpd = require('node-dhcpd');
const netmask = require('netmask').Netmask;

const inspect = require('util').inspect;
const debug = require('debug')('DHCPServer');

const
  BOOTREQUEST       = 1,
  DHCP_MESSAGE_TYPE = 0x35,
  DHCP_SERVER_ID    = 0x36,
  DHCP_DISCOVER     = 1,
  DHCP_INFORM       = 8,
  DHCP_MINTYPE      = DHCP_DISCOVER,
  DHCP_MAXTYPE      = DHCP_INFORM,
  DHCP_REQUESTED_IP = 0x32,
  DHCP_HOST_NAME    = 0x0c;

function _getOption(pkt, opt) {
  return (opt in pkt.options) ? pkt.options[opt] : undefined;
}

class DHCPServer {
  constructor(options) {
    let self = this;

    self.host = options.host;
    self.leases = options.leases;
    if (options.subnet) {
      let block = new netmask(options.subnet);
      if (block) {
        self.network = block.base;
        self.netmask = block.mask;
        self.routers = options.routers;
        self.default_lease = 86400;
      }
    }

    self.server = new dhcpd('udp4', { broadcast: '255.255.255.255' });
    
    self.server.on('listening', function() {
      let address = self.server.address();
      debug('server listening - %s:%s', address.address, address.port);
    });

    self.server.on('discover', self.handleDiscover.bind(self));
    self.server.on('request', self.handleRequest.bind(self));

    self.server.bind(67, '0.0.0.0', function() {
      self.server.setMulticastTTL(255);
      self.server.addMembership('239.255.255.249', self.host);
    });
  }

  handleDiscover(pkt) {
    let self = this;
    self._preProcess('dis', pkt, () => {
      debug('[DSICOVER] New request');

      var offer = {};
      offer.siaddr = self.host;
      offer.yiaddr = self.leases[pkt.chaddr];

      offer.options = {};
      offer.options['1'] = self.netmask;
      offer.options['3'] = self.routers;
      offer.options['51'] = self.default_lease;
      offer.options['54'] = self.host;
      offer.options['255'] = null;

      self.server.offer(pkt, offer);
    });
  }

  handleRequest(pkt) {
    let self = this;
    self._preProcess('req', pkt, () => {
      debug('[REQUEST] New request');

      let requestedIP = pkt.options[DHCP_REQUESTED_IP];
      if (requestedIP && requestedIP == self.leases[pkt.chaddr]) {
        debug('Accept Request.');
        pkt.yiaddr = self.leases[pkt.chaddr];
        pkt.options = {
          1: self.netmask,
          3: self.routers,
          51: self.default_lease,
          54: self.host,
          255: null
        };

        self.server.ack(pkt);
      } else {
        debug('Reject Request.');
        pkt.options['255'] = null;
        self.server.nak(pkt);
      }
    });
  }

  _preProcess(type, pkt, callback) {
    let self = this;

    if (pkt.hlen != 6) {
      return;
    }

    if (pkt.op != BOOTREQUEST) {
      return;
    }

    if (!self.leases[pkt.chaddr]) {
      return;
    }
    
    if (_getOption(pkt, DHCP_SERVER_ID) == self.host) {
      callback();
      return;
    }

    // Ignore unicast
    if (pkt.flags == 0) {
      return;
    }

    let state = _getOption(pkt, DHCP_MESSAGE_TYPE);
    if (state == undefined || state[0] < DHCP_MINTYPE || state[0] > DHCP_MAXTYPE) {
      return;
    }

    let server_id_opt = _getOption(pkt, DHCP_SERVER_ID);
    if (server_id_opt && server_id_opt != self.host) {
      return;
    }

    callback();
  }
}

module.exports = DHCPServer;