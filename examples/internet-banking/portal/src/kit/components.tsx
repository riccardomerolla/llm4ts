import type { ReactNode } from "react"
import type { Paged } from "./api.ts"
import { useAuth } from "./auth.tsx"
import { useConfig } from "./config.tsx"
import { LANGUAGE_NAMES, LANGUAGES, useI18n, useMessages } from "./i18n.tsx"
import { kitMessages } from "./messages.ts"

export interface NavItem {
  readonly id: string
  readonly label: string
}

/** Application frame: bank branding, demonstration banner, navigation, and the signed-in customer. */
export const Shell = ({
  items,
  current,
  onSelect,
  children
}: {
  readonly items: ReadonlyArray<NavItem>
  readonly current: string
  readonly onSelect: (id: string) => void
  readonly children: ReactNode
}) => {
  const config = useConfig()
  const { customer, signOut } = useAuth()
  const t = useMessages(kitMessages)
  return (
    <div className="shell">
      <div className="demo-banner" role="status">
        {t("shell.demoBanner")}
      </div>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">{config.bankName}</span>
          <span className="brand-title">{t("shell.title")}</span>
        </div>
        <div className="identity">
          <LanguageSwitch />
          <span className="muted">{customer.name}</span>
          <button type="button" className="link" onClick={signOut}>
            {t("shell.signOut")}
          </button>
        </div>
      </header>
      <div className="body">
        <nav className="sidenav" aria-label={t("shell.screens")}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === current ? "nav active" : "nav"}
              onClick={() => onSelect(item.id)}
              aria-current={item.id === current ? "page" : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  )
}

/** Two words, not a dropdown: with one alternative a menu costs more than it explains. */
export const LanguageSwitch = () => {
  const { language, setLanguage } = useI18n()
  const t = useMessages(kitMessages)
  return (
    <span className="lang" role="group" aria-label={t("shell.language")}>
      {LANGUAGES.map((code) => (
        <button
          key={code}
          type="button"
          className={code === language ? "lang-option active" : "lang-option"}
          aria-pressed={code === language}
          onClick={() => setLanguage(code)}
        >
          {LANGUAGE_NAMES[code]}
        </button>
      ))}
    </span>
  )
}

export const Panel = ({
  title,
  children,
  actions
}: {
  readonly title: string
  readonly children: ReactNode
  readonly actions?: ReactNode
}) => (
  <section className="panel">
    <div className="panel-head">
      <h2>{title}</h2>
      {actions === undefined ? null : <div className="panel-actions">{actions}</div>}
    </div>
    {children}
  </section>
)

/** A labelled control; the error, when present, replaces the hint and is announced. */
export const Field = ({
  label,
  children,
  hint,
  error
}: {
  readonly label: string
  readonly children: ReactNode
  readonly hint?: string
  readonly error?: string
}) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {error !== undefined ? (
      <span className="field-error" role="alert">
        {error}
      </span>
    ) : hint === undefined ? null : (
      <span className="field-hint">{hint}</span>
    )}
  </label>
)

/** A refusal is announced assertively so a screen reader interrupts; a confirmation is not. */
export const Notice = ({ text, tone = "info" }: { readonly text: string | undefined; readonly tone?: "info" | "error" }) =>
  text === undefined ? null : (
    <p className={tone === "error" ? "notice error" : "notice"} role={tone === "error" ? "alert" : "status"}>
      {text}
    </p>
  )

export type BadgeTone = "live" | "done" | "pending" | "attention"

/** A state as a chip. The feature maps its own vocabulary to a tone and a translated label. */
export const StateBadge = ({ label, tone }: { readonly label: string; readonly tone: BadgeTone }) => (
  <span className={`badge ${tone}`}>{label}</span>
)

/** A headline figure: the value leads, the label supports it. */
export const Figure = ({
  label,
  value,
  attention = false
}: {
  readonly label: string
  readonly value: string
  readonly attention?: boolean
}) => (
  <div className="figure">
    <span className="figure-label">{label}</span>
    <span className={attention ? "figure-value figure-attention" : "figure-value"}>{value}</span>
  </div>
)

/** Label/value pairs, for details that are not a table. */
export const KeyValues = ({ rows }: { readonly rows: ReadonlyArray<readonly [string, ReactNode]> }) => (
  <dl className="kv">
    {rows.map(([label, value]) => (
      <div key={label} style={{ display: "contents" }}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
)

export interface Column<Row> {
  readonly key: string
  readonly header: string
  readonly render: (row: Row) => ReactNode
  readonly numeric?: boolean
}

export const DataTable = <Row,>({
  rows,
  columns,
  empty,
  rowKey
}: {
  readonly rows: ReadonlyArray<Row>
  readonly columns: ReadonlyArray<Column<Row>>
  readonly empty: string
  readonly rowKey: (row: Row) => string
}) => (
  <div className="table-wrap">
    {rows.length === 0 ? (
      <p className="muted">{empty}</p>
    ) : (
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.numeric === true ? "num" : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.numeric === true ? "num" : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
)

/** Builds a CSV text from rows; the browser offers it as a download. */
export const downloadCsv = (
  filename: string,
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): void => {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  const text = [header, ...rows].map((row) => row.map(escape).join(",")).join("\n")
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/** The button under a paged table; nothing when the last page is shown. */
export const LoadMore = ({ paged }: { readonly paged: Paged<unknown> }) => {
  const t = useMessages(kitMessages)
  if (!paged.hasMore) return null
  return (
    <div className="panel-actions">
      <button type="button" disabled={paged.loading} onClick={paged.loadMore}>
        {t("common.showMore")}
      </button>
    </div>
  )
}

/** A select with an "all" option first, for narrowing a list. */
export const SelectFilter = <V extends string>({
  label,
  value,
  options,
  onChange
}: {
  readonly label: string
  readonly value: V | ""
  readonly options: ReadonlyArray<{ readonly value: V; readonly label: string }>
  readonly onChange: (value: V | "") => void
}) => {
  const t = useMessages(kitMessages)
  return (
    <label className="filter">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) =>
          onChange(options.find((option) => option.value === event.target.value)?.value ?? "")
        }
      >
        <option value="">{t("common.all")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The loading line every screen shows before its first data. */
export const Loading = () => {
  const t = useMessages(kitMessages)
  return <p className="muted">{t("common.loading")}</p>
}
