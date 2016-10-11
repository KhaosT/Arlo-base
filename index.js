'use strict';

const storage = require('node-persist');
const Arlo = require('./arlo');

let self = this;

storage.initSync();

let arloServer = new Arlo({
  subnet: '10.0.1.0/24',
  cameras: [
    {
      mac: '40:5d:82:2f:33:46',
      address: '10.0.1.40',
      name: 'Living Room'
    },
    {
      mac: 'dc:ef:09:bb:c6:59',
      address: '10.0.1.41',
      name: 'Side'
    }
  ]
});