import SuiteDetailPage from '@/containers/SuiteDetailPage/SuiteDetailPage';

/** Params are a promise in the App Router; the container takes the plain id. */
export default async function Page({ params }: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await params;
  return <SuiteDetailPage suiteId={suiteId} />;
}
