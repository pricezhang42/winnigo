'use client';
import {useState} from 'react';
export default function Page() {
  const [count, setCount] = useState(0);
  return <main><h1>Winnigo P0 compatibility</h1><div className="probe-grid"><p>Isolated test app</p><button onClick={() => setCount(count + 1)}>Hydration check: {count}</button></div></main>;
}
