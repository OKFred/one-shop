import { getContextValue, setContextValue } from '@evershop/evershop/graphql/services';
import { getBaseUrl } from '@evershop/evershop/lib/util/getBaseUrl';

export default (request, response, next) => {
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  setContextValue(request, 'pageInfo', {
    ...getContextValue(request, 'pageInfo', {}),
    title: 'Wholesale enquiries | SHUSHA',
    description: 'Explore clothing from Sri Lanka for your online store or social shop. Request a personal quotation for your chosen styles and quantities.',
    canonicalUrl: `${getBaseUrl().replace(/\/$/, '')}/wholesale`
  });
  next();
};
