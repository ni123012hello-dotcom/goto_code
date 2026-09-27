import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md text-s-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}
