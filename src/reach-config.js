'use strict';
// REACH1: this listing's Pro tools for the preview toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'zovoD2',
  triesKey: 'zovoD2.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'export', title: 'Export PNG, PDF and SVG', command: 'zovoD2.export' },
    { id: 'batch', title: 'Batch export', command: 'zovoD2.batchExport' },
  ],
};
