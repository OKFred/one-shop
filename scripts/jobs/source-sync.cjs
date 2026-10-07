'use strict';

// Material capture retains gallery/READY facts. Only the backend API writer
// updates existing product prices; capture prices are source review evidence.
module.exports = () => require('./run.cjs')('source-sync', [
  ['scripts/suusha-source.cjs', ['--capture', '--new-arrivals', '24']],
  ['scripts/shusha-sync-prices.mjs', ['--apply'], [0, 2]],
  ['scripts/suusha-source.cjs', ['--download', '--max-files', '500', '--max-bytes', '134217728'], [0, 2]],
  ['scripts/suusha-source.cjs', ['--library-report']]
]);
