import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} compliance webhook for ${shop}`);

  // MANDATORY: Delete all stored data for this shop within 48 hours.
  // This fires 48 hours after the app is uninstalled.
  // See: https://shopify.dev/docs/apps/build/privacy-law-compliance

  return new Response();
};
