'use client';
import { signIn } from 'next-auth/react';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow">
        <h2 className="text-2xl font-bold text-gray-900">Sign in</h2>
        <button
          onClick={() => signIn('github', { callbackUrl: '/dashboard' })}
          className="mt-6 w-full rounded-md bg-gray-900 px-4 py-2 text-white hover:bg-gray-700"
        >
          Continue with GitHub
        </button>
        <button
          onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
          className="mt-3 w-full rounded-md border border-gray-300 px-4 py-2 hover:bg-gray-50"
        >
          Continue with Google
        </button>
      </div>
    </div>
  );
}
