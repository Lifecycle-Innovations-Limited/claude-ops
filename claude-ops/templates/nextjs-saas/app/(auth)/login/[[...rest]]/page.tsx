import { SignIn } from '@clerk/nextjs'

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <SignIn routing="path" path="/login" signUpUrl="/register" fallbackRedirectUrl="/dashboard" />
    </div>
  )
}
