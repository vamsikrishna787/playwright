import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="empty">
      <p>No such page.</p>
      <Link href="/">Back to the suites</Link>
    </div>
  );
}
