'use strict';
const run = require('./run.cjs');
module.exports = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type).value;
  const slot = `${value('year')}-${value('month')}-${value('day')}`;
  return run('material-drop', [
    ['scripts/publish-material-drop.cjs', ['--publish-next', '--apply', '--limit', '2', '--slot', slot]]
  ]);
};
