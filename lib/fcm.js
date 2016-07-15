var util = require('util');
var https = require('https');
var querystring = require('querystring');
var emitter = require('events').EventEmitter;
var retry = require('retry');

function FCM(serverKey) {
    if (serverKey) {
        this.serverKey = serverKey;
    } else {
        throw Error('No serverKey is given.');
    }

    this.fcmOptions = {
        host: 'fcm.googleapis.com',
        port: 443,
        path: '/fcm/send',
        method: 'POST',
        headers: {}
    };
}

util.inherits(FCM, emitter);

FCM.prototype.send = function(payload, CB) {
    var self = this;
    if (CB) this.once('sent', CB);

    var operation = retry.operation();

    payload = JSON.stringify(payload);

    operation.attempt(function(currentAttempt) {
        var headers = {
            'Host': self.fcmOptions.host,
            'Authorization': 'key=' + self.serverKey,
            'Content-Type': 'application/json',
            'Content-Length': new Buffer(payload).length
        };

        self.fcmOptions.headers = headers;

        if (self.keepAlive) headers.Connection = 'keep-alive';

        var request = https.request(self.fcmOptions, function(res) {
            var data = '';


            if (res.statusCode == 503) {
                // If the server is temporary unavailable, the C2DM spec requires that we implement exponential backoff
                // and respect any Retry-After header
                if (res.headers['retry-after']) {
                    var retrySeconds = res.headers['retry-after'] * 1; // force number
                    if (isNaN(retrySeconds)) {
                        // The Retry-After header is a HTTP-date, try to parse it
                        retrySeconds = new Date(res.headers['retry-after']).getTime() - new Date().getTime();
                    }
                    if (!isNaN(retrySeconds) && retrySeconds > 0) {
                        operation._timeouts['minTimeout'] = retrySeconds;
                    }
                }
                if (!operation.retry('TemporaryUnavailable')) {
                    self.emit('sent', operation.mainError(), null);
                }
                // Ignore all subsequent events for this request
                return;
            }

            function respond() {
                var error = null,
                    feedback = null;
                
                var data_json = null;
                try{
                    data_json = JSON.parse(data);
                }catch(exception){
                    // we'll do a null-check later
                }
                
                if(data_json && data_json.results.length){
                    // request processed, maybe with feedback
                    feedback = {
                        "error": data_json.results[0].error || null,
                        "registration_id": data_json.results[0].registration_id || null,
                        "message_id": data_json.results[0].message_id || null,
                        "multicast_id": data_json.multicast_id || null
                    };
                }
                
                if(!feedback){
                    error = "InvalidServerResponse";
                }else if(feedback.error){
                    error = feedback.error;
                }

                // Only retry if error is QuotaExceeded or DeviceQuotaExceeded
                if (operation.retry(currentAttempt <= 3 && error ? error : null)) {
                    return;
                }

                // Success, return feedback
                self.emit('sent', error, feedback);
            }

            res.on('data', function(chunk) {
                data += chunk;
            });
            res.on('end', respond);
            res.on('close', respond);
        });

        request.on('error', function(error) {
            self.emit('sent', error, null);
        });

        request.end(payload);
    });
};

module.exports = FCM;