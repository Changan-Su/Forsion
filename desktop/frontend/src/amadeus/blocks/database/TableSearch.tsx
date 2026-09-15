import { useId, useState } from 'react'
import { useI18n } from '../../../i18n'

/** A table query is not a credential field. Ignore unsolicited background fills. */
export function TableSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n()
  const id = useId()
  const [editing, setEditing] = useState(false)
  return <input className="amx-db-search" type="search" name={`table-query-${id}`} form={`table-query-form-${id}`}
    autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
    data-lpignore="true" data-1p-ignore="true" data-bwignore="true"
    readOnly={!editing} value={value} placeholder={t('dbembed.searchPlaceholder')} aria-label={t('dbembed.searchRows')}
    onFocus={() => setEditing(true)} onBlur={(e) => { setEditing(false); e.currentTarget.value = value }}
    onChange={(e) => {
      const input = e.currentTarget
      if (!editing || input.ownerDocument.activeElement !== input || input.matches(':autofill')) { input.value = value; return }
      onChange(input.value)
    }} />
}
