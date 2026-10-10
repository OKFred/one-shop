import React from 'react';
import { NavigationItemGroup } from '@components/admin/NavigationItemGroup';
import { Layers } from 'lucide-react';

export default function ShopifyMenu({ shopifyBridge }) {
  if (!shopifyBridge) return null;
  return <NavigationItemGroup id="shushaOperationsMenu" name="SHUSHA" items={[{ Icon: Layers, url: shopifyBridge, title: 'Both stores & operations' }]} />;
}

export const layout = { areaId: 'adminMenu', sortOrder: 25 };
export const query = `query Query { shopifyBridge: url(routeId:"shopifyBridge") }`;
