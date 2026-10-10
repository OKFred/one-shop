import bodyParser from 'body-parser';

const parser = bodyParser.json({ type: 'application/json', inflate: false, limit: '16kb', strict: true });
export default (request, response, next) => {
  response.set('Cache-Control', 'private, no-store, max-age=0');
  if (!request.is('application/json')) return response.status(415).json({ error: 'JSON_REQUIRED' });
  return parser(request, response, (error) => {
    if (error) return response.status(error.status === 413 ? 413 : 400).json({ error: 'INVALID_ORDER_OPERATION' });
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) return response.status(400).json({ error: 'INVALID_ORDER_OPERATION' });
    return next();
  });
};
