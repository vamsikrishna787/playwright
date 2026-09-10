import TestEditorPage from '@/containers/TestEditorPage/TestEditorPage';

export default async function Page({ params }: { params: Promise<{ testId: string }> }) {
  const { testId } = await params;
  return <TestEditorPage testId={testId} />;
}
