import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    productId: payload.id,
    title: payload.title,
    status: payload.status,
  });

  // TODO: Sync product changes — update catalog, adjust inventory, etc.

  return new Response();
};
