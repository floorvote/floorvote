import { ReactNode } from 'react'

export type Column<T> = {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  width?: string | number
}

export function DataTable<T>({ rows, columns, rowKey, empty, rowClassName }: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string | number
  empty?: ReactNode
  rowClassName?: (row: T) => string | undefined
}) {
  if (rows.length === 0) {
    return <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>{empty ?? 'No rows.'}</div>
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>
          {columns.map(col => (
            <th key={col.key} style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border)', color: 'var(--muted)', fontWeight: 600, width: col.width }}>
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={rowKey(row)} className={rowClassName?.(row)}>
            {columns.map(col => (
              <td key={col.key} style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                {col.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
