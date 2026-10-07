import React from 'react';
import { InputField } from '@components/common/form/InputField.js';
import { ToggleField } from '@components/common/form/ToggleField.js';
import { Card, CardContent, CardHeader, CardTitle } from '@components/common/ui/Card.js';

const fields = [
  ['bankTransferDisplayName', 'Display name'],
  ['bankTransferContactSriLanka', 'Sri Lanka contact / WhatsApp'],
  ['bankTransferContactChina', 'China contact / WhatsApp']
];
export default function BankTransferSetting({ setting }) {
  return <Card><CardHeader><CardTitle>SHUSHA Wise / bank transfer order requests</CardTitle></CardHeader><CardContent>
    <p className="mb-4">Orders remain unpaid until funds are verified. Confirm availability and the merchandise payment quote on each order. Shipping remains pending and is arranged separately.</p>
    <p className="mb-4">Verified bank details and the Wise Business open link are configured privately on the server. Customers see them after their payment quote is confirmed.</p>
    <ToggleField name="bankTransferPaymentStatus" defaultValue={setting.bankTransferPaymentStatus} trueValue={1} falseValue={0} />
    {fields.map(([name, label]) => <div key={name} className="mt-4"><InputField name={name} label={label} defaultValue={setting[name]} /></div>)}
  </CardContent></Card>;
}
export const layout = { areaId: 'paymentSetting', sortOrder: 25 };
export const query = `query Query { setting { bankTransferPaymentStatus bankTransferDisplayName bankTransferContactSriLanka bankTransferContactChina } }`;
