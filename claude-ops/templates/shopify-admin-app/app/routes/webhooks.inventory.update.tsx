import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    inventoryItemId: payload.inventory_item_id,
    locationId: payload.location_id,
    available: payload.available,
  });

  // TODO: Handle inventory level changes — reorder alerts, sync, etc.

  return new Response();
};
