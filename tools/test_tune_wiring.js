#!/usr/bin/env node
// Local sanity test: does the route parse and log tune params correctly?
// Cannot run full vectorizeToDST (sharp/potrace missing), but verifies
// that params.tune is propagated from body to the vector call site.

const path = require('path');
const os = require('os');

// Stub vectorize so we can inspect the params it receives
const Module = require('module');
const originalResolve = Module._resolveFilename;
let capturedParams = null;

const vectorizePath = require.resolve('../lib/vectorize.js');
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.endsWith('/lib/vectorize.js') || request === './lib/vectorize.js' || request === '../lib/vectorize.js') {
    return vectorizePath;
  }
  return originalResolve.apply(this, arguments);
};

// Monkey-patch vectorizeToDST to capture params without running potrace
const vectorize = require('../lib/vectorize.js');
const originalFn = vectorize.vectorizeToDST;
vectorize.vectorizeToDST = async function(cleanedBuffer, colors, canvasSize, pxPerMm, params) {
  capturedParams = params;
  return { dst: Buffer.from('fake'), stats: { colors: colors.length } };
};

// Minimal request/response stubs
const fakeReq = {
  body: {
    jobId: 'test_tune',
    mode: 'cartoon',
    colorCount: '7',
    canvasSize: '1600',
    tune: JSON.stringify({ bridgeMaxGap: 42, absorbMinArea: 999, autoZoomMargin: 0.123 }),
    extractedSubject: '1'
  },
  file: { buffer: Buffer.from('fake-image'), mimetype: 'image/png' }
};

const fakeRes = {
  status: function() { return this; },
  json: function(d) { this._json = d; return this; },
  sendFile: function() { return this; }
};

const fakeNext = (err) => { if (err) throw err; };

// Import route and call the handler directly
const router = require('../routes/index.js');
// The router is a middleware; find the POST /generate-embroidery handler
const layer = router.stack.find(l => l.route && l.route.path === '/generate-embroidery' && l.route.methods.post);
if (!layer) {
  console.error('Could not find POST /generate-embroidery handler');
  process.exit(1);
}

(async () => {
  try {
    await layer.route.stack[layer.route.stack.length - 1].handle(fakeReq, fakeRes, fakeNext);
    if (!capturedParams) {
      console.error('FAIL: vectorizeToDST was not called');
      process.exit(1);
    }
    const tune = capturedParams.tune;
    if (!tune || tune.bridgeMaxGap !== 42 || tune.absorbMinArea !== 999 || tune.autoZoomMargin !== 0.123) {
      console.error('FAIL: tune not propagated correctly', JSON.stringify(capturedParams));
      process.exit(1);
    }
    console.log('PASS: tune params propagated to vectorizeToDST:', JSON.stringify(tune));
  } catch (e) {
    console.error('FAIL:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
