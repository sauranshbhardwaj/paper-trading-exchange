import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="not-found">
      <p className="not-found-code mono">404</p>
      <h1>Nothing trades here.</h1>
      <p className="text-muted-tilt">That page doesn't exist.</p>
      <Link to="/" className="btn btn-accent">
        Back to the markets
      </Link>
    </main>
  );
}
