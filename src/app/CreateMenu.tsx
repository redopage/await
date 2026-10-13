import { ChatBubbleLeftRightIcon, DocumentTextIcon, HashtagIcon, PlusIcon, SparklesIcon, Squares2X2Icon, UserPlusIcon } from '@heroicons/react/16/solid';

type CreateAction = 'message' | 'channel' | 'document' | 'board' | 'agent' | 'invite';

const items = [
  { id: 'message', title: 'Message', description: 'Start a direct conversation', icon: ChatBubbleLeftRightIcon },
  { id: 'channel', title: 'Channel', description: 'Bring a group together by topic', icon: HashtagIcon },
  { id: 'document', title: 'Document', description: 'Capture notes and decisions', icon: DocumentTextIcon },
  { id: 'board', title: 'Task board', description: 'Plan and track work', icon: Squares2X2Icon },
  { id: 'agent', title: 'Agent', description: 'Add an AI teammate', icon: SparklesIcon },
] as const;

export default function CreateMenu({ open, onToggle, onChoose, canInvite }: { open: boolean; onToggle: () => void; onChoose: (action: CreateAction) => void; canInvite: boolean }) {
  return <>
    <button type="button" className={`sidebar-create-button ${open ? 'active' : ''}`} aria-label="Create" aria-expanded={open} aria-haspopup="menu" onClick={onToggle}><span className="sidebar-create-mark"><PlusIcon /></span><span>Create</span></button>
    {open && <div className="create-menu" role="menu" aria-label="Create">
      <h2>Create</h2>
      <div className="create-menu-items">{items.map((item) => <button type="button" role="menuitem" tabIndex={-1} className={`create-menu-item create-${item.id}`} key={item.id} onClick={() => onChoose(item.id)}><span className="create-menu-icon"><item.icon /></span><span className="create-menu-copy"><strong>{item.title}</strong><small>{item.description}</small></span></button>)}</div>
      {canInvite && <div className="create-menu-footer"><button type="button" role="menuitem" tabIndex={-1} className="create-menu-item create-invite" onClick={() => onChoose('invite')}><span className="create-menu-icon"><UserPlusIcon /></span><span className="create-menu-copy"><strong>Invite people</strong><small>Bring teammates into this workspace</small></span></button></div>}
    </div>}
  </>;
}
