import Link from 'next/link';

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-white to-gray-50 p-8">
      <h1 className="text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl">
        Your SaaS Product
      </h1>
      <p className="mt-4 text-xl text-gray-600 max-w-xl text-center">
        Description of what your product does. Replace this with your value proposition.
      </p>
      <div className="mt-8 flex gap-4">
        <Link
          href="/register"
          className="rounded-md bg-indigo-600 px-6 py-3 text-white font-semibold hover:bg-indigo-500"
        >
          Get started
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-gray-300 px-6 py-3 font-semibold hover:bg-gray-50"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
