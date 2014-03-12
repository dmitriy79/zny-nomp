var redis = require('redis');
var async = require('async');

var Stratum = require('stratum-pool');




module.exports = function(logger){

    var poolConfigs = JSON.parse(process.env.pools);


    Object.keys(poolConfigs).forEach(function(coin) {
        SetupForPool(logger, poolConfigs[coin]);
    });

};


function SetupForPool(logger, poolOptions){

    var coin = poolOptions.coin.name;

    var processingConfig = poolOptions.shareProcessing.internal;

    if (!processingConfig.enabled) return;

    var logIdentify = 'Payment Processor (' + coin + ')';

    var paymentLogger = {
        debug: function(key, text){
            logger.logDebug(logIdentify, key, text);
        },
        warning: function(key, text){
            logger.logWarning(logIdentify, key, text);
        },
        error: function(key, text){
            logger.logError(logIdentify, key, text);
        }
    };

    var daemon = new Stratum.daemon.interface([processingConfig.daemon]);
    daemon.once('online', function(){
        paymentLogger.debug('system', 'Connected to daemon for payment processing');

        daemon.cmd('validateaddress', [poolOptions.address], function(result){
            if (!result[0].response.ismine){
                paymentLogger.error('system', 'Daemon does not own pool address - payment processing can not be done with this daemon');
            }
        });
    }).once('connectionFailed', function(error){
        paymentLogger.error('system', 'Failed to connect to daemon for payment processing: ' + JSON.stringify(error));
    }).on('error', function(error){
        paymentLogger.error('system', error);
    }).init();



    var redisClient;


    var connectToRedis = function(){
        var reconnectTimeout;
        redisClient = redis.createClient(processingConfig.redis.port, processingConfig.redis.host);
        redisClient.on('ready', function(){
            clearTimeout(reconnectTimeout);
            paymentLogger.debug('redis', 'Successfully connected to redis database');
        }).on('error', function(err){
                paymentLogger.error('redis', 'Redis client had an error: ' + JSON.stringify(err))
        }).on('end', function(){
            paymentLogger.error('redis', 'Connection to redis database as been ended');
            paymentLogger.warning('redis', 'Trying reconnection in 3 seconds...');
            reconnectTimeout = setTimeout(function(){
                connectToRedis();
            }, 3000);
        });
    };
    connectToRedis();




    var processPayments = function(){
        async.waterfall([

            /* Check redis for all pending block submissions, then pass along each object with:
                  {
                    transHash1: {height: blockHeight1},
                    transHash2: {height: blockHeight2}
                  }
            */
            function(callback){
                redisClient.smembers(coin + '_blocks', function(error, results){
                    if (error){
                        logger.error('redis', 'Could get blocks from redis ' + JSON.stringify(error));
                        callback('done - redis error for getting blocks');
                        return;
                    }
                    if (results.length === 0){
                        callback('done - no pending blocks in redis');
                        return;
                    }

                    var txs = {};
                    results.forEach(function(item){
                        var details = item.split(':');
                        var txHash = details[0];
                        var height = details[1];
                        txs[txHash] = {height: height};
                    });
                    callback(null, txs);
                });
            },

            /* Receives txs object with key, checks each key (the transHash) with block batch rpc call to daemon.
               Each confirmed on get the amount added to transHash object as {amount: amount},
               Non confirmed txHashes get deleted from obj. Then remaining txHashes are passed along
            */
            function(txs, callback){

                var batchRPCcommand = [];

                for (var txHash in txs){
                    batchRPCcommand.push(['gettranscation', [txHash]]);
                }

                daemon.batchCmd(batchRPCcommand, function(error, txDetails){

                    txDetails.forEach(function (tx){
                        var confirmedTxs = txDetails.filter(function(tx){
                            var txDetails = tx.details[0];
                            if (txDetails.categery === 'generate'){
                                txs[txDetails.txid].amount = txDetails.amount;
                            }
                            else delete txs[txDetails.txid];

                        });
                        if (Object.keys(txs).length === 0){
                            callback('done - no confirmed transactions yet');
                            return;
                        }
                        callback(null, txs);
                    });
                });
            },

            /* Use height from each txHash to get worker shares from each round and pass along */
            function(txs, callback){


                var shareLooksup = [];
                for (var hash in txs){
                    var height = txs[hash].height;
                    shareLooksup.push(['hgetall', coin + '_shares:round' + height]);
                }

                redisClient.multi(shareLooksup).exe(function(error, responses){
                    if (error){
                        callback('done - redis error with multi get rounds share')
                        return;
                    }
                    console.dir(response);
                    callback(response);
                });


                //get balances_coin from redis for each address in this round
                //add up total balances
                //send necessary payments
                //put left over balances in redis
                //clean up (move block entry to processedBlocks_coin) so this logic isn't called again

            },

            /* Get worker existing balances from coin_balances hashset in redis*/
            function(confirmedTxs, callback){

                /* Calculate if any payments are ready to be sent and trigger them sending
                   Get remaining balances for each address and pass it along as object of latest balances
                   such as {worker1: balance1, worker2, balance2} */

            },

            /* update remaining balances in coin_balance hashset in redis */
            function(updateBalances, callback){

            },

            //move this block enty to coin_processedBlocks so payments are not resent
            function (none, callback){

            }

        ], function(error, result){
            //log error completion
        });
    };


    setInterval(function(){

        processPayments();

    }, processingConfig.paymentInterval * 1000);

};