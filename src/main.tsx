import { StrictMode } from 'react'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import { createRoot } from 'react-dom/profiling'
import './index.css'
import BatchPerformanceComparison from './Batch.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BatchPerformanceComparison />
  </StrictMode>,
)
