/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

// you have to require the utils module and call adapter function
const utils = require(__dirname + '/lib/utils'); // Get common adapter utils

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.lirc.0
const adapter = new utils.Adapter('lirc');
const lirc_client = require('lirc-client');  // for opening a socket listener

let lirc_instances = {};  // holds instances for the devices
let adapter_db_prefix;  // prefix of the adapter in the db

// triggered when the adapter is installed
adapter.on('install', function () {
});

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
  adapter.setState('info.connection', false);
  callback(false);
});

// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
  adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

  // get operating mode
  let devid = id.split('.').slice(2, 3)[0];  // the device (ip + port)
  let remote = id.split('.').slice(-2)[0];  // the remote e.g. Philips
  let key = id.split('.').slice(-1)[0];  // the pressed key e.g. power

  let op_mode = get_operating_mode(devid, remote);  // operating mode e.g. switch or button

  switch(op_mode) {
    case 'switch':
      lirc_instances[devid].sendOnce(remote, key).catch((err) => {
        adapter.log.error('Could not send key ' + key + ' on remote '
          + remote + ' from device ' + devid + ', error ' + err);
      });
      break;
    case 'button':
      if(state.val) {
        lirc_instances[devid].sendOnce(remote, key).then(() => {
          adapter.setState(id, false, true);  // reset button
        })
        .catch((err) => {
          adapter.log.error('Could not send key ' + key + ' on remote '
            + remote + ' from device ' + devid + ', error ' + err);
        });
      }
      break;
  }
});

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
  adapter_db_prefix = 'lirc.' + adapter.instance + '.';

  main();
});

function main() {
  // The adapters config (in the instance object everything under the attribute "native") is accessible via

  // check setup of all remotes
  syncConfig((err) => {
    // get subscribeable states form the db
    adapter.subscribeStates(adapter_db_prefix + '*');

    // create LIRC instances for each device
    for (let i=0;i<adapter.config.devices.length;i++) {
      let id = ip_to_id(adapter.config.devices[i].ip, adapter.config.devices[i].port);
      if (!lirc_instances.hasOwnProperty(id)) {
        // create instance
        lirc_instances[id] = new lirc_client({
          host: adapter.config.devices[i].ip,
          port: parseInt(adapter.config.devices[i].port)
        });
      }
    }
  });
}

// sync config with database
function syncConfig(callback) {
  function is_dev_in_config(device, device_list) {
    let id = id_to_ip(device._id.split('.').slice(-1)[0]);

    let ip = id.split(':')[0];
    let port = id.split(':')[1];

    for (let i=0;i<device_list.length;i++) {
      if(ip === device_list[i].ip
        && port === device_list[i].port) {

        return true;
      }
    }
    return false;
  }

  function is_dev_in_db(device, device_list) {
    for (let i=0;i<device_list.length;i++) {
      let ip_port = id_to_ip_port(device_list[i]._id);

      if(device.ip === ip_port.ip
        && device.port === ip_port.port) {

        return true;
      }
    }
    return false;
  }

  function is_channel_in_db(channel, channel_list) {
    for (let _chan in channel_list) {
      if (!channel_list.hasOwnProperty(_chan)) continue;
      let chan = channel_list[_chan];

      if(channel.remote === chan.common.name) {
        return true;
      }
    }
    return false;
  }

  adapter.getDevices(function (err, devices) {
    // go through all devices in the config
    for (let i=0;i<adapter.config.devices.length;i++) {
      // do we have to remove the whole device?
      if(!is_dev_in_db(adapter.config.devices[i], devices)) {
        // this one has to be added

        if (adapter.config.devices[i].ip && adapter.config.devices[i].port && adapter.config.devices[i].remote) {
          createBasicStates(adapter.config.devices[i])
        }
      } else {
        // the devices are there, but are there missing channels?
        adapter.getForeignObjects(
          adapter_db_prefix + ip_to_id(adapter.config.devices[i].ip, adapter.config.devices[i].port) + '.*',
          'channel', (err, _channels) => {

          // is there a channel missing in the db?
          if (!is_channel_in_db(adapter.config.devices[i], _channels)) {
            // this one has to be added
            createBasicStates(adapter.config.devices[i])
          }
        });
      }
    }

    // go through all devices in the db
    for (let i=0;i<devices.length;i++) {
      if(!is_dev_in_config(devices[i], adapter.config.devices)) {
        // this one has to be removed
        adapter.delObject(devices[i]._id);

        // TODO: channels have to be removed correctly
        // deleteChannelFromEnum = function deleteChannelFromEnum(enumName, parentDevice, channelName, callback)
        /*
        adapter.deleteChannelFromEnum('room', ip_to_id(_device.ip, _device.port), _device.remote, function (err) {
          if (err) adapter.log.error('Could not add LIRC with ' + _device.ip + ' to enum. Error: ' + err);
        });*/
      }
    }
  });

  if(callback) callback(false);
}

// create states for a LIRC remote
function createBasicStates(device, callback) {
  let _device = device;

  adapter.log.debug('Create basic states for remote: ip '
    + device.ip + ':' + device.port + ', remote ' + device.remote);

  let obj = {
    _id: adapter_db_prefix + ip_to_id(device.ip, device.port),
    type: 'device',
    common: {
      name: device.ip + ':' + device.port
    },
    native: {}
  };

  // create the device
  adapter.setObjectNotExists(obj._id, obj);

  // create channel
  let obj_ch = {
    _id: adapter_db_prefix + cleanid(ip_to_id(device.ip, device.port) + '.' + device.remote),
    type: 'channel',
    common: {
      name: device.remote
    },
    native: {}
  };

  // create the device
  adapter.setObjectNotExists(obj_ch._id, obj_ch, (err) => {
    // add the to the corresponding room enum
    if (!err && _device.room) {
      // addChannelToEnum = function addChannelToEnum(enumName, addTo, parentDevice, channelName, callback)
      adapter.addChannelToEnum('room', _device.room, ip_to_id(_device.ip, _device.port), _device.remote, function (err) {
        if (err) adapter.log.error('Could not add LIRC with ' + _device.ip + ' to enum. Error: ' + err);
      });
    }
  });

  // get the states
  let clirc = new lirc_client({
    host: device.ip,
    port: parseInt(device.port)
  });

  clirc.on('connect', () => {
    clirc.send('VERSION').then(res => {
      adapter.log.info('Successfully connected to LIRC version ' + res[0] + '.');
    })
    .catch((err) => {
      adapter.log.error('LIRC error on connection! ' + err);
    });

    clirc.list(device.remote).then(res => {
      // go through the commands and create the corresponding states
      for (let i=0;i<res.length;i++) {
        if (res[i].split(' ').length < 2) {
          adapter.log.warn('Invalid command ' + device.remote.res[i]);
          continue;
        }

        let obj_state = {
          _id: cleanid(adapter_db_prefix
                       + ip_to_id(device.ip, device.port)
                       + '.' + device.remote + '.'
                       + res[i].split(' ')[1]),
          type: 'state',
          common: {
            name: res[i].split(' ')[1],
            read: false,
            write: true,
            def: false,
            role: 'button',
            type: 'boolean'
          },
          native: {}
        };

        adapter.setObjectNotExists(obj_state._id, obj_state);
      }
    })
    .catch((err) => {
      adapter.log.error('LIRC error when retrieving the command listing: ' + err);
    })
  });
}

// convert ip to a valid state id
function ip_to_id(ip, port) {
  return ip.replace(/[.\s]+/g, '_') + '-' + port;
}

// convert a state id to an ip
function id_to_ip(id) {
  return id.replace(/[_\s]+/g, '.').replace(/[-\s]+/g, ':');
}

// convert id to a dict
function id_to_ip_port(id) {
  let myid = id_to_ip(id.split('.').slice(-1)[0]);

  let ip = myid.split(':')[0];
  let port = myid.split(':')[1];

  return {ip: ip, port: port};
}

// return valid state ids only
function cleanid(id) {
  return id.replace(/[!\*?\[\]\"\']/ig, '_');
}

// returns the operating mode (e.g. switch or button)
function get_operating_mode(devid, remote) {
  let ipport = id_to_ip_port(devid);

  for (let i=0;i<adapter.config.devices.length;i++) {
    if(adapter.config.devices[i].ip === ipport.ip
      && adapter.config.devices[i].port === ipport.port
      && adapter.config.devices[i].remote === remote) {
      return adapter.config.devices[i].operating_mode;
    }
  }
  return false;
}
