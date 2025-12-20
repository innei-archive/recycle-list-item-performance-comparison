import { StrictMode } from 'react'
import { createRoot } from 'react-dom/profiling'
import './index.css'
import BatchPerformanceComparison from './Batch.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BatchPerformanceComparison />
  </StrictMode>,
)
