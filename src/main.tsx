import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import BatchPerformanceComparison from './Batch.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BatchPerformanceComparison />
  </StrictMode>,
)
