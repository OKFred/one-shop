import bodyParser from 'body-parser';
export default (request, response, next) => bodyParser.json({ inflate: false, limit: '8kb' })(request, response, next);
