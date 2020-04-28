
"use strict";

//-----------------------------------------------------------------------------
// constants
//-----------------------------------------------------------------------------

const SOH = 0x01;	// start of header
const ETX = 0x03;	// end of text
const ACK = 0x06;   // acknowledge
const DLE = 0x10;   // data link escape
const NAK = 0x15;	// not acknowledge
const MAX_DATA_LENGTH = 494;
//
const FRAME_TYPE_VARIABLE = 2;	// INCO frame type 'variable'
const FRAME_SUBTYPE_PUT = 0;	// put variable
const FRAME_SUBTYPE_GET = 1;	// get variable
const FRAME_TYPE_PROCEDURE = 4;	// INCO frame type 'procedure'

//-----------------------------------------------------------------------------
// variables
//-----------------------------------------------------------------------------

var cTarget = ""
var uFrameNumber = 0;
var uRecFrameNumber = 0;
var uFrameInfo = 0;
var uFrameType = 0;
var uFrameSubType = 0;
var uErrorNumber = 0;
var uErrorSubNumber = 0;
var uCounter = 0;
var uIndex = 0;
var uWriteIndex = 0;
var uControlChar = 0;
var uChecksum = 0;
var uRecChecksum = 0;
var uState = 0;
var uNrData = 0;
var cBuffer = new Buffer(64);
var uData = new Buffer(256);
var uTemp = new Buffer(8);
var ip = require('ip');
var ipAddress = ip.address();
var locks = require('locks');
var mutex = locks.createMutex();
var timestamp;

//
// Reset module
//
function reset() {
	// reset members
	uWriteIndex = 0;
	uControlChar = 0;
	uChecksum = 0;
}
//
// Output to buffer
//
function output (value) {
	value = value & 0xff;
	if (value == DLE) {
		cBuffer[uWriteIndex++] = value;
	}
	cBuffer[uWriteIndex++] = value;
	uChecksum += value;
}
//
// Output control char to buffer
//
function outputControl (value) {
	cBuffer[uWriteIndex++] = DLE;
	cBuffer[uWriteIndex++] = value;
	uChecksum += value;
}
//
// Frame receive state machine
//
function input (aChar)
{
	// check DLE
    if (uControlChar) {
        uControlChar = 0;
        if ((aChar==SOH) || (aChar==ACK) || (aChar==NAK))
            uState = 1;
        else if ((aChar==ETX) && (uState==30))
            uState = 31;
    }
    else if (aChar==DLE){
        uControlChar = 1;
        return;
    }
    
    // switch state
    switch (uState & 0xff){
		// wait for DLE/SOH, DLE/ACK, DLE/NAK
        case 0 :
			break;
        // wait for SOH / ACK / NAK
        case 1 :
            switch (aChar){
                case SOH :
                case ACK :
                case NAK :
                    // yes I got it
                    uState = 2;
                    // init checksum
                    uRecChecksum = 0;
                    // init frame data
                    uFrameInfo = aChar;
                    break;
                    // else
                default :
                    // reset state
                    uState = 0;
            }
            break;
        // wait for FN (frame number)
        case 2 :
            uRecFrameNumber = aChar;
            switch (uFrameInfo){
                // primary frame
                case SOH :
                    uState = 3;
                    break;
                // secondary ACK frame
                case ACK :
                    uState = 5;
                    break;
                // secondary NAK frame
                case NAK :
                    uState = 10;
                    break;
            }
            break;
        // PRIMARY FRAME wait for FT (frame type)
        case 3 :
            uFrameType = aChar;
            uState = 4;
            break;
        // PRIMARY FRAME wait for FST (frame sub type)
        case 4 :
            uFrameSubType = aChar;
            uState = 10;
            break;
        // SECONDARY ACK FRAME wait for EN (error number)
        case 5 :
            uErrorNumber = aChar;
            uState = 6;
            break;
        // SECONDARY ACK FRAME wait for ESN (error sub number)
        case 6 :
            uErrorSubNumber = aChar;
            uState = 10;
            break;
        // ALL FRAMES wait for NDS (number of destination bytes)
        case  10 :
            uCounter = aChar;
            uIndex = 0;
            uState = 11;
            break;
        // ALL FRAMES wait for slave number
        case 11 :
            // adjust destination bytes counter
            uCounter--;
            // number ok
            if (uCounter)
                uState = 12;
            else {
                // check frame type
                if (uFrameInfo==SOH)
                    // primary frame
                    uState = 13;
                else
                    // secondary frame
                    uState = 20;    // wait for checksum
 			}
			break;
        // ALL FRAMES wait for destination bytes
        case 12 :
            // adjust destination bytes counter
            uCounter--;
            // set destination byte
            uTemp[uIndex++] = aChar;
            // number ok
            if (!uCounter){
                // check frame type
                if (uFrameInfo==SOH)
                    // primary frame
                    uState = 13;
                else
                    // secondary frame
                    uState = 20;    // wait for checksum
            }
            break;
        // PRIMARY FRAME wait for NSR (number of source bytes)
        case 13 :
            // check source length
            if (aChar<=7){
                // length ok -> insert device number
                uIndex = 1;
                uCounter = aChar;
                uState = 14;
            }
            else{
                // length not supported
                uState = 0;
            }
            break;
        // PRIMARY FRAME wait for source bytes
        case 14 :
            // adjust source bytes counter
            uCounter--;
            // number ok
            if (!uCounter)
                uState = 20;    // wait for checksum
            break;
        // ALL FRAMES wait for CS1 (header checksum)
        case 20 :
            // check checksum
            if (((aChar+uRecChecksum) & 0xFF)==0xFF){
                // ok
                if (uFrameInfo==NAK){
                    // reset state
                    uState = 0;
                }
                else {
                    uState = 30;    // wait for data
                    uIndex = 0;     // reset index
                    uRecChecksum = 0;  // reset checksum
                    return;
                }
            }
            else{
                // CS1 not ok
                uState = 0;
            }
            break;
        // PRIMARY FRAME and SECONDARY ACK FRAME wait for data
        case 30 :
            // check index overflow
            if (uIndex<MAX_DATA_LENGTH){
                // ok
                uData[uIndex++] = aChar;
                // add 00 to next char to be compatible with old inco servers
                // who send just a one byte SPR number in functions Put/GetSPR
                // (inco_dbg assumes a two byte number)
                uData[uIndex+1] = 0;
            }
            else{
                uState = 0;
                // just give primary error frame to the dispatcher
                if (uFrameInfo==SOH){
                    // overflow -> set frame error
                    uFrameInfo |= 0x80;
               }
            }
            break;
        // PRIMARY FRAME and SECONDARY ACK FRAME ETX received
        case 31 :
            // set number of data bytes
            uNrData = uIndex;
            uState = 32; // wait for checksum
            break;
        // PRIMARY FRAME and SECONDARY ACK FRAME wait for checksum
        case 32 :
			// check checksum
            if (((aChar+uRecChecksum) & 0xFF)!=0xFF){
                // check frame type
                if (uFrameInfo==SOH){
					// PRIMARY FRAME -> set frame error -> dispatcher creates NAK frame
		            uFrameInfo |= 0x80;
				}
				else{
					// SECONDARY ACK FRAME -> change frame type to NAK, so the
					// dispatcher gives it to the waiting task and the task initiates
					// a retry
					uFrameInfo = NAK;
				}
			}
            // reset state
            uState = 0;
            break;
        default :
            uState = 0;
    }
    // adjust checksum
    uRecChecksum += aChar;
}

var inco = {
	//
	//	Init module
	//
	init : function(target) {
		// trace info 
		console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + ' Setting target : ' + target);
		// set target ip address
		cTarget = target
	},
	//
	//	Get variable from target
	//
	getVariable : function(variableName, callback) {
		// wait for mutex	
		mutex.lock(function () {
			// trace info	
			console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + ' getVariable (' + variableName + ')');
			// lets start
			reset();
			// DLE, SOH
			outputControl(SOH);
			// frame number
			output(uFrameNumber++);
			// frame type
			output(FRAME_TYPE_VARIABLE);
			// frame sub type
			output(FRAME_SUBTYPE_GET);
			// number of destination bytes
			output(1);
			// destination byte (hack, assume  192.168.1.3)
			output(3);
			// number of source bytes
			output(1);
			// lowest byte of my ip address
			output(ip.toLong(ipAddress) & 0xff);
			// checksum
			output(uChecksum ^ 0xff);
			// reset checksum
			uChecksum = 0;
			// variable name
			for (var i = 0; i<variableName.length; i++){
				output(variableName.charCodeAt(i));
			}
			// ending 0
			output(0);
			// ETX
			outputControl(ETX);
			// checksum
			output(uChecksum ^ 0xff);

			// print out debug info
			console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + ' Sent:     ' + cBuffer.toString('hex', 0, uWriteIndex));

			var dgram = require('dgram');
			var client = dgram.createSocket('udp4', function(msg, rinfo) {
				// trace info
				console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + " received: " + msg.toString("hex"));
				// parse frame
				for (var i=0; i<msg.length; i++) {
					// handle over to our famous input method
					input(msg[i]);			
				}
				// convert to little endian
				var buffer = new ArrayBuffer(8);
				var bytes = new Uint8Array(buffer);
				var doubleView = new Float64Array(buffer);
				for (var i=0; i<8; i++){
					bytes[7-i] = uData[i];
				}
				// finally return result
				callback(null, doubleView[0]);
				// close socket
				client.close();
				// unlock
				mutex.unlock();
			});
			// send out
			client.send(cBuffer, 0, uWriteIndex, 1964, cTarget);
		});
	},
	//
	// Put variable to target
	//
	putVariable : function(variableName, value, callback) {
		// wait for mutex	
		mutex.lock(function () {
			// trace info
			console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + ' putVariable (' + variableName + ', ' + value + ')');
			// lets start
			reset();
			// DLE, SOH
			outputControl(SOH);
			// frame number
			output(uFrameNumber++);
			// frame type
			output(FRAME_TYPE_VARIABLE);
			// frame subtype
			output(FRAME_SUBTYPE_PUT);
			// number of destination bytes
			output(1);
			// destination byte
			output(3);
			// number of source bytes
			output(1);
			// lowest byte of my ip address
			output(ip.toLong(ipAddress) & 0xff);
			// checksum
			output(uChecksum ^ 0xff);
			// reset checksum
			uChecksum = 0;
			// write value
			var buffer = new ArrayBuffer(8);
			var bytes = new Uint8Array(buffer);
			var doubleView = new Float64Array(buffer);
			doubleView[0] = value;
			for (var i=0; i<8; i++){
				output(bytes[7-i]);
			} 
			// write name
			for (var i=0; i<variableName.length; i++) {
				output(variableName.charCodeAt(i));
			}
			// ending 0
			output(0);
			// ETX
			outputControl(ETX);
			// checksum
			output(uChecksum ^ 0xff);

			// print out debug info
			console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + ' Sent:     ' + cBuffer.toString('hex', 0, uWriteIndex));

			var dgram = require('dgram');
			var client = dgram.createSocket('udp4', function(msg, rinfo) {
				// trace info
				console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + " received: " + msg.toString("hex"));
				// parse frame
				for (var i=0; i<msg.length; i++) {
					// handle over to our famous input method
					input(msg[i]);			
				}
				// finally return result
				callback(null);
				// close socket
				client.close();
				// unlock
				mutex.unlock();
			});
			// send out
			client.send(cBuffer, 0, uWriteIndex, 1964, cTarget);
		});
	},
	//
	// call procedure
	//
	callProcedure : function(procedureName, callback) {
		// wait for mutex	
		mutex.lock(function () {
			// trace info
			console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + ' callProcedure (' + procedureName + ')');
			// lets start
			reset();
			// DLE, SOH
			outputControl(SOH);
			// frame number
			output(uFrameNumber++);
			// frame type
			output(FRAME_TYPE_PROCEDURE);
			// frame subtype
			output(0);
			// number of destination bytes
			output(1);
			// destination byte
			output(3);
			// number of source bytes
			output(1);
			// lowest byte of my ip address
			output(ip.toLong(ipAddress) & 0xff);
			// checksum
			output(uChecksum ^ 0xff);
			// reset checksum
			uChecksum = 0;
			// we currently don't support params
			output(0);
			output(0);
			output(0);
			output(0);
			// write name
			for (var i=0; i<procedureName.length; i++) {
				output(procedureName.charCodeAt(i));
			}
			// ending 0
			output(0);
			// ETX
			outputControl(ETX);
			// checksum
			output(uChecksum ^ 0xff);

			// print out debug info
			console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + ' Sent:     ' + cBuffer.toString('hex', 0, uWriteIndex));

			var dgram = require('dgram');
			var client = dgram.createSocket('udp4', function(msg, rinfo) {
				// trace info
				console.log(timestamp('YYYY-MM-DD hh:mm:ss:iii') + " received: " + msg.toString("hex"));
				// parse frame
				for (var i=0; i<msg.length; i++) {
					// handle over to our famous input method
					input(msg[i]);			
				}
				// finally return result
				callback(null);
				// close socket
				client.close();
				// unlock
				mutex.unlock();
			});
			// send out
			client.send(cBuffer, 0, uWriteIndex, 1964, cTarget);
		});
	}
}

//
//	singleton
//
function singleton() {
	if(global.singleton_instance === undefined) {
		timestamp = require('console-timestamp');
		global.singleton_instance = Object.create(inco);
	}
	return global.singleton_instance;
}

module.exports = singleton();

