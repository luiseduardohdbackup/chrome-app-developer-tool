/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
*/
(function() {
    'use strict';
    /* global myApp */
    /* global chrome */

// Server actions:
//
// Show in-app overlay menu:
//     curl -v -X POST "http://$IP_ADDRESS:2424/menu"
//
// Execute a JS snippet:
//     curl -v -X POST "http://$IP_ADDRESS:2424/exec?code='alert(1)'"
//
// Starts the app with the given ID (or the first app if none is given):
//     curl -v -X POST "http://$IP_ADDRESS:2424/launch?appId=a.b.c"
//
// Returns JSON of server info / app state:
//     curl -v "http://$IP_ADDRESS:2424/info"
//
// Returns JSON of the asset manifest for the given app ID (or the first app if none is given):
//     curl -v "http://$IP_ADDRESS:2424/assetmanifest?appId=a.b.c"
//
// Tell the interface that an update is in progress for the given app ID (or the first app if none is given):
//     echo '{"transferSize": 100}' | curl -v -X POST -d @- "http://$IP_ADDRESS:2424/prepupdate?app=foo"
//
// Deletes a set of files within the given app ID (or the first app if none is given):
//     echo '{"paths":["www/index.html"]}' | curl -v -X POST -d @- "http://$IP_ADDRESS:2424/deletefiles?appId=a.b.c"
//
// Updates a single file within the given app ID (or the first app if none is given):
//     cat file | curl -v -X PUT -d @- "http://$IP_ADDRESS:2424/assetmanifest?appId=a.b.c&path=www/index.html&etag=1234"
//
// Deletes the app with the given ID (or the first app if none is given):
//     curl -v -X POST "http://$IP_ADDRESS:2424/deleteapp?appId=a.b.c"
//     curl -v -X POST "http://$IP_ADDRESS:2424/deleteapp?all=true" # Delete all apps.

    myApp.factory('HarnessServer', ['$q', 'HttpServer', 'ResourcesLoader', 'AppHarnessUI', 'AppsService', 'notifier', 'APP_VERSION', function($q, HttpServer, ResourcesLoader, AppHarnessUI, AppsService, notifier, APP_VERSION) {

        var PROTOCOL_VER = 2;
        var server = null;
        var listenAddress = null;

        function ensureMethodDecorator(method, func) {
            return function(req, resp) {
                if (req.method != method) {
                    return resp.sendTextResponse(405, 'Method Not Allowed\n');
                }
                return func(req, resp);
            };
        }

        function pipeRequestToFile(req, destUrl) {
            var writer = null;
            function handleChunk(arrayBuffer) {
                var ret = $q.when();
                if (writer == null) {
                   ret = ResourcesLoader.createFileWriter(destUrl)
                   .then(function(w) {
                       writer = w;
                   });
                }
                return ret.then(function() {
                    var deferred = $q.defer();
                    writer.onwrite = deferred.resolve;
                    writer.onerror = function() {
                      deferred.reject(writer.error);
                    };
                    writer.write(arrayBuffer);
                    return deferred.promise;
                })
                .then(function() {
                    if (req.bytesRemaining > 0) {
                        return req.readChunk().then(handleChunk);
                    }
                });
            }
            return req.readChunk().then(handleChunk);
        }

        function handleExec(req, resp) {
            var js = req.getQueryParam('code');
            return AppHarnessUI.evalJs(js)
            .then(function() {
                resp.sendTextResponse(200, '');
            });
        }

        function handleMenu(req, resp) {
            resp.sendTextResponse(200, '');
            return AppHarnessUI.createOverlay();
        }

        function handleLaunch(req, resp) {
            var appId = req.getQueryParam('appId');
            return AppsService.getAppById(appId)
            .then(function(app) {
                if (app) {
                    return AppsService.launchApp(app)
                    .then(function() {
                        return resp.sendTextResponse(200, '');
                    });
                }
                return resp.sendTextResponse(412, 'No apps available for launch\n');
            });
        }

        function getAssetManifestJson(app) {
            return {
                'assetManifest': app && app.directoryManager.getAssetManifest(),
                'assetManifestEtag': app ? app.directoryManager.getAssetManifestEtag() : '0',
                'platform': cordova.platformId,
                'cordovaVer': cordova.version,
                'protocolVer': PROTOCOL_VER
            };
        }

        function handleAssetManifest(req, resp) {
            var appId = req.getQueryParam('appId');
            return AppsService.getAppById(appId)
            .then(function(app) {
                return resp.sendJsonResponse(200, getAssetManifestJson(app));
            });
        }

        function handleDeleteFiles(req, resp) {
            var appId = req.getQueryParam('appId');
            var manifestEtag = req.getQueryParam('manifestEtag');
            return AppsService.getAppById(appId)
            .then(function(app) {
                return req.readAsJson()
                .then(function(requestJson) {
                    if (app) {
                        if (manifestEtag && app.directoryManager.getAssetManifestEtag() !== manifestEtag) {
                            return resp.sendJsonResponse(409, getAssetManifestJson(app));
                        }
                        var paths = requestJson['paths'];
                        for (var i = 0; i < paths.length; ++i) {
                            app.directoryManager.deleteFile(paths[i]);
                        }
                    } else {
                        console.log('Warning: tried to delete files from non-existant app: ' + appId);
                    }
                    return resp.sendTextResponse(200, '');
                });
            });
        }

        function handleDeleteApp(req, resp) {
            var appId = req.getQueryParam('appId');
            var all = req.getQueryParam('all');
            var ret;
            if (all) {
                ret = AppsService.uninstallAllApps();
            } else {
                ret = AppsService.getAppById(appId)
                .then(function(app) {
                    if (app) {
                        return AppsService.uninstallApp(app);
                    }
                });
            }
            return ret.then(function() {
                return resp.sendTextResponse(200, '');
            });
        }

        function handlePutFile(req, resp) {
            var appId = req.getQueryParam('appId');
            var appType = req.getQueryParam('appType') || 'cordova';
            var path = req.getQueryParam('path');
            var etag = req.getQueryParam('etag');
            var manifestEtag = req.getQueryParam('manifestEtag');
            if (!path || !etag) {
                throw new Error('Request is missing path or etag query params');
            }
            return AppsService.getAppById(appId, appType)
            .then(function(app) {
                // Checking the manifest ETAG is meant to catch the case where
                // the client has cached the manifest from a first push, and
                // wants to validate that it is still valid at the start of a
                // subsequent push (e.g. make sure the device hasn't changed).
                if (manifestEtag && app.directoryManager.getAssetManifestEtag() !== manifestEtag) {
                    return resp.sendJsonResponse(409, getAssetManifestJson(app));
                }
                startUpdateProgress(app, req);
                var tmpUrl = ResourcesLoader.createTmpFileUrl();
                return pipeRequestToFile(req, tmpUrl)
                .then(function() {
                    return importFile(tmpUrl, path, app, etag);
                })
                .then(function() {
                    return incrementUpdateStatusAndSendManifest(app, req, resp);
                });
            });
        }

        // This is set at the beginning of a push to show progress bar
        // across multiple requests.
        function startUpdateProgress(app, req) {
            // This is passed for the first file only, and is used to track total progress.
            var expectTotal = +req.getQueryParam('expectBytes') || req.headers['content-length'];
            app.updatingStatus = 0;
            app.updateBytesTotal = expectTotal;
            app.updateBytesSoFar = 0;
        }

        function incrementUpdateStatusAndSendManifest(app, req, resp) {
            if (app.updatingStatus !== null) {
                // TODO: Add a timeout that resets updatingStatus if no more requests come in.
                app.updateBytesSoFar += +req.headers['content-length'];
                app.updatingStatus = app.updateBytesTotal / app.updateBytesSoFar;
                if (app.updatingStatus === 1) {
                    app.updatingStatus = null;
                    app.lastUpdated = new Date();
                    notifier.success('Update complete.');
                }
            }
            return resp.sendJsonResponse(200, {
                'assetManifestEtag': app.directoryManager.getAssetManifestEtag()
            });
        }

        function importFile(fileUrl, destPath, app, etag) {
            console.log('Adding file: ' + destPath);
            if (destPath == 'www/cordova_plugins.js') {
                destPath = 'orig-cordova_plugins.js';
            }
            return app.directoryManager.addFile(fileUrl, destPath, etag);
        }

        function handleZipPush(req, resp) {
            var appId = req.getQueryParam('appId');
            var appType = req.getQueryParam('appType') || 'cordova';
            var manifestEtag = req.getQueryParam('manifestEtag');
            return AppsService.getAppById(appId, appType)
            .then(function(app) {
                if (manifestEtag && app.directoryManager.getAssetManifestEtag() !== manifestEtag) {
                    return resp.sendJsonResponse(409, getAssetManifestJson(app));
                }
                startUpdateProgress(app, req);
                var tmpZipUrl = ResourcesLoader.createTmpFileUrl();
                var tmpDirUrl = ResourcesLoader.createTmpFileUrl() + '/';
                return pipeRequestToFile(req, tmpZipUrl)
                .then(function() {
                    console.log('Extracting update zip');
                    return ResourcesLoader.extractZipFile(tmpZipUrl, tmpDirUrl);
                })
                .then(function() {
                    return ResourcesLoader.readJSONFileContents(tmpDirUrl + 'zipassetmanifest.json');
                })
                .then(function(zipAssetManifest) {
                    var keys = Object.keys(zipAssetManifest);
                    return $q.when()
                    .then(function next() {
                        var k = keys.shift();
                        if (k) {
                            return importFile(tmpDirUrl + k, k, app, zipAssetManifest[k]['etag'])
                            .then(next);
                        }
                    });
                })
                .then(function() {
                    return incrementUpdateStatusAndSendManifest(app, req, resp);
                })
                .finally(function() {
                    app.updatingStatus = null;
                    ResourcesLoader.delete(tmpZipUrl);
                    ResourcesLoader.delete(tmpDirUrl);
                });
            });
        }

        function handleInfo(req, resp) {
            var activeApp = AppsService.getActiveApp();
            var json = {
                'platform': cordova.platformId,
                'cordovaVer': cordova.version,
                'protocolVer': PROTOCOL_VER,
                'harnessVer': APP_VERSION,
                'supportedAppTypes': ['cordova'],
                'userAgent': navigator.userAgent,
                'activeAppId': activeApp && activeApp.appId,
                'appList': AppsService.getAppListAsJson()
            };
            resp.sendJsonResponse(200, json);
        }

        function start() {
            if (server) {
                return;
            }
            server = new HttpServer()
                .addRoute('/exec', ensureMethodDecorator('POST', handleExec))
                .addRoute('/menu', ensureMethodDecorator('POST', handleMenu))
                .addRoute('/launch', ensureMethodDecorator('POST', handleLaunch))
                .addRoute('/info', ensureMethodDecorator('GET', handleInfo))
                .addRoute('/assetmanifest', ensureMethodDecorator('GET', handleAssetManifest))
                .addRoute('/deletefiles', ensureMethodDecorator('POST', handleDeleteFiles))
                .addRoute('/putfile', ensureMethodDecorator('PUT', handlePutFile))
                .addRoute('/zippush', ensureMethodDecorator('POST', handleZipPush))
                .addRoute('/deleteapp', ensureMethodDecorator('POST', handleDeleteApp));
            return server.start();
        }

        function getListenAddress() {
            if (listenAddress) {
                return $q.when(listenAddress);
            }
            var deferred = $q.defer();
            chrome.socket.getNetworkList(function(interfaces) {
                // Filter out ipv6 addresses.
                var ret = interfaces.filter(function(i) {
                    return i.address.indexOf(':') === -1;
                }).map(function(i) {
                    return i.address;
                }).join(', ');
                listenAddress = ret;
                deferred.resolve(ret);
            });
            return deferred.promise;
        }

        return {
            start: start,
            getListenAddress: getListenAddress
        };
    }]);
})();