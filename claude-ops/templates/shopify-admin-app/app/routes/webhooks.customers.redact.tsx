import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} compliance webhook for ${shop}`, {
    customerId: payload.customer?.id,
  });

  // MANDATORY: Delete all stored customer data within 30 days.
  // See: https://shopify.dev/docs/apps/build/privacy-law-compliance

  return new Response();
};
