import { auth, currentUser } from '@clerk/nextjs/server'
import { prisma } from './prisma'

/** Ensures a Prisma User row exists for the signed-in Clerk user (used for Stripe metadata.userId). */
export async function syncClerkUser() {
  const { userId } = await auth()
  if (!userId) {
    return null
  }

  const clerkUser = await currentUser()
  if (!clerkUser) {
    return null
  }

  const primaryEmail =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress

  if (!primaryEmail) {
    return null
  }

  const nameFromParts = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ')
  const name = clerkUser.fullName ?? (nameFromParts || null)

  return prisma.user.upsert({
    where: { clerkUserId: userId },
    update: {
      email: primaryEmail,
      name,
      image: clerkUser.imageUrl ?? null,
    },
    create: {
      clerkUserId: userId,
      email: primaryEmail,
      name,
      image: clerkUser.imageUrl ?? null,
    },
  })
}
