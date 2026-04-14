# Registry Templates

Pre-baked starter `registry.json` files for common stacks. Diff against `scripts/registry.example.json` and adapt.

| Template | When to use |
|---|---|
| nextjs-saas.json | Single Next.js SaaS on Vercel |
| react-native-mobile.json | Mobile subscription app on EAS + RevenueCat |
| python-microservices.json | Multiple Python services on AWS ECS |
| monorepo.json | Monorepo with multiple apps/services in one repo |

Copy a template to `scripts/registry.json` and edit to match your projects, or run `/ops:setup registry` to go through the guided wizard.
