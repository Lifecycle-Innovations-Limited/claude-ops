import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { prisma } from '../../../../lib/prisma';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' });

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature')!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const subscription = event.data.object as Stripe.Subscription;
    await prisma.subscription.upsert({
      where: { stripeSubscriptionId: subscription.id },
      update: { status: subscription.status },
      create: {
        stripeSubscriptionId: subscription.id,
        status: subscription.status,
        userId: subscription.metadata.userId,
      },
    });
  }

  return NextResponse.json({ received: true });
}
