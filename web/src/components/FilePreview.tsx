import { Modal } from "../ui"
import CodeView from "./CodeView"

type Props = {
  sessionID: string
  path: string
  onClose: () => void
}

/** The control seat opens the viewer as a modal over the transcript. The review seat does not
 *  use this - it docks CodeView as its main pane instead. */
export default function FilePreview({ sessionID, path, onClose }: Props) {
  return (
    <Modal
      title={path}
      note="只读查看"
      onClose={onClose}
      className="max-w-6xl"
      bodyClassName="flex min-h-0 flex-col p-0"
    >
      <CodeView sessionID={sessionID} path={path} />
    </Modal>
  )
}
