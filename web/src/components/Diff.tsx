/** Unified diff. Colour does the work: added moss, removed rust, hunk header ember. */
export default function Diff({ patch }: { patch: string }) {
  const lines = patch.split("\n")

  return (
    <pre className="s-well overflow-x-auto p-2 leading-[1.5]">
      {lines.map((line, index) => {
        let cls = "text-s-soft"
        if (line.startsWith("@@")) cls = "text-s-ember"
        else if (line.startsWith("+++") || line.startsWith("---")) cls = "text-s-faint"
        else if (line.startsWith("+")) cls = "bg-s-moss/10 text-s-moss"
        else if (line.startsWith("-")) cls = "bg-s-rust/10 text-s-rust"
        else if (line.startsWith("\\")) cls = "text-s-faint"

        return (
          <div key={index} className={`whitespace-pre ${cls}`}>
            {line || " "}
          </div>
        )
      })}
    </pre>
  )
}
