import { clientEntry, type Handle } from 'remix/component'

export const WorkspaceTitleCoordinator = clientEntry(
  import.meta.url + '#WorkspaceTitleCoordinator',
  function WorkspaceTitleCoordinator(handle: Handle<{ title: string }>) {
    return () => {
      let title = handle.props.title

      // Frame navigation replaces only the workspace surface, so the document
      // head is not reconciled with the dynamic title computed by the server.
      // Queue the update after each reconciliation so preserved client entries
      // also apply newly received title props.
      handle.queueTask((signal) => {
        if (!signal.aborted && document.title !== title) document.title = title
      })

      return <span hidden aria-hidden="true" data-workspace-document-title={title}></span>
    }
  },
)
