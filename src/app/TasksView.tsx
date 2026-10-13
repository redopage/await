import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpIcon, ArrowsUpDownIcon, CalendarDaysIcon, ChatBubbleLeftIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CodeBracketIcon, MagnifyingGlassIcon, PlusIcon, ShareIcon, Squares2X2Icon, TableCellsIcon } from '@heroicons/react/16/solid';
import type { ProjectRun } from '../shared/projects';
import type { Member, TaskBoard, TaskReference, TeamTask } from '../shared/types';
import { taskStatuses as statuses } from '../shared/types';
import { initials } from '../shared/members';
import { api, navigate, post } from './api';
import DataTable from './DataTable';
import LoadNotice from './LoadNotice';
import Modal from './Modal';

type Props = { workspaceId: string; channelId: string; members: Member[]; createSignal?: number; onCreateHandled?: () => void; requestedBoardId?: string; requestedTaskId?: string; embedded?: boolean; projectRuns?: ProjectRun[]; onShare?: (kind: 'task' | 'board' | 'document', title: string, url: string) => Promise<void> };

function TaskCard({ task, members, linkedRun, onOpen }: { task: TeamTask; members: Member[]; linkedRun?: ProjectRun; onOpen: () => void }) {
  const assignee = members.find((member) => member.account_id === task.assignee_id);
  return <button type="button" className="task-card" draggable onDragStart={(event) => event.dataTransfer.setData('text/task-id', task.id)} onClick={onOpen}>
    <div className="task-card-head">
      <span className={`task-check ${task.status === 'done' ? 'done' : ''}`}>{task.status === 'done' && <CheckIcon />}</span>
      <strong>{task.title}</strong>
    </div>
    {task.description && <p>{task.description}</p>}
    <div className="task-card-foot">
      {task.due_at && <span>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(task.due_at)}</span>}
      {task.priority !== 2 && <span className={`task-pill priority priority-${task.priority}`}>{task.priority === 3 ? 'High' : 'Low'} priority</span>}
      {(task.reference_count ?? 0) > 0 && <small className="task-ref" title={`Referenced in ${task.reference_count} ${task.reference_count === 1 ? 'message' : 'messages'}`}><ChatBubbleLeftIcon /> {task.reference_count}</small>}
      {assignee && <span className="task-assignee" title={`Assigned to ${assignee.name}`}>
        {assignee.avatar_url ? <img src={assignee.avatar_url} alt="" /> : initials(assignee.name)}
      </span>}
    </div>
    {linkedRun && <span className="task-card-link"><CodeBracketIcon /> {linkedRun.status === 'working' ? 'Agent working' : linkedRun.title}</span>}
  </button>;
}

// Messages that linked this card with <task:id>, newest first.
function TaskReferences({ workspaceId, taskId, members, onOpen }: { workspaceId: string; taskId: string; members: Member[]; onOpen: () => void }) {
  const detail = useQuery({ queryKey: ['task-references', workspaceId, taskId], queryFn: () => api<TeamTask & { references: TaskReference[] }>(`/workspaces/${workspaceId}/collab/tasks/${taskId}`), staleTime: 15000 });
  const references = detail.data?.references ?? [];
  if (!references.length) return null;
  return <div className="task-references"><h3>Referenced in</h3><ul>{references.map((reference) => <li key={reference.message_id}><button type="button" onClick={() => { onOpen(); navigate(`/w/${workspaceId}/${reference.channel_id}?thread=${reference.thread_id ?? reference.message_id}`); }}><strong>{members.find((member) => member.account_id === reference.author_id)?.name ?? 'Former member'}</strong><time dateTime={new Date(reference.created_at).toISOString()}>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(reference.created_at)}</time><span>{reference.excerpt}</span></button></li>)}</ul></div>;
}

type TaskSort = 'title' | 'status' | 'priority' | 'assignee' | 'due';

function TaskTable({ tasks, members, onOpen }: { tasks: TeamTask[]; members: Member[]; onOpen: (task: TeamTask) => void }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: TaskSort; direction: 'asc' | 'desc' }>({ key: 'status', direction: 'asc' });
  const memberNames = useMemo(() => new Map(members.map((member) => [member.account_id, member.name])), [members]);
  const visibleTasks = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const filtered = term ? tasks.filter((task) => `${task.title} ${task.description} ${memberNames.get(task.assignee_id ?? '') ?? ''}`.toLocaleLowerCase().includes(term)) : tasks;
    return [...filtered].sort((left, right) => {
      if (sort.key === 'due' && (left.due_at === null || right.due_at === null)) {
        if (left.due_at === right.due_at) return left.created_at - right.created_at;
        return left.due_at === null ? 1 : -1;
      }
      const value = sort.key === 'title' ? left.title.localeCompare(right.title)
        : sort.key === 'status' ? statuses.findIndex((item) => item.id === left.status) - statuses.findIndex((item) => item.id === right.status)
        : sort.key === 'priority' ? left.priority - right.priority
        : sort.key === 'assignee' ? (memberNames.get(left.assignee_id ?? '') ?? 'zzz').localeCompare(memberNames.get(right.assignee_id ?? '') ?? 'zzz')
        : (left.due_at ?? 0) - (right.due_at ?? 0);
      return (sort.direction === 'asc' ? value : -value) || left.created_at - right.created_at;
    });
  }, [tasks, memberNames, search, sort]);
  function heading(label: string, key: TaskSort) {
    return <th scope="col" aria-sort={sort.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : undefined}><button type="button" className="data-table-sort" onClick={() => setSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }))}>{label}{sort.key === key ? <ArrowUpIcon aria-hidden="true" className={sort.direction === 'desc' ? 'descending' : ''} /> : <ArrowsUpDownIcon aria-hidden="true" />}</button></th>;
  }
  return <section className="task-table-view" aria-label="Task table">
    <div className="task-table-toolbar">
      <label className="task-table-search">
        <MagnifyingGlassIcon aria-hidden="true" />
        <span className="sr-only">Search tasks</span>
        <input name="task-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks" />
      </label>
      <p>{visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'}</p>
    </div>
    <DataTable label="Tasks on this board">
      <thead>
        <tr>
          {heading('Task', 'title')}
          {heading('Status', 'status')}
          {heading('Priority', 'priority')}
          {heading('Assignee', 'assignee')}
          {heading('Due date', 'due')}
        </tr>
      </thead>
      <tbody>
        {visibleTasks.map((task) => { const assignee = members.find((member) => member.account_id === task.assignee_id); return <tr key={task.id}>
          <td>
            <button type="button" className="task-table-title" onClick={() => onOpen(task)}>
              {task.status === 'done' && <CheckIcon aria-hidden="true" />}
              {task.title}
            </button>
          </td>
          <td>
            <span className={`task-status status-${task.status}`}>{statuses.find((item) => item.id === task.status)?.name}</span>
          </td>
          <td>
            <span className={`task-priority priority-${task.priority}`}>
              {task.priority === 3 ? 'High' : task.priority === 2 ? 'Normal' : 'Low'}
            </span>
          </td>
          <td>
            {assignee ? <span className="task-table-person">
              <span className="task-table-avatar">
                {assignee.avatar_url ? <img src={assignee.avatar_url} alt="" /> : initials(assignee.name)}
              </span>
              {assignee.name}
            </span> : <span className="task-table-empty">Unassigned</span>}
          </td>
          <td className="task-table-date">
            {task.due_at ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(task.due_at) : <span className="task-table-empty">No due date</span>}
          </td>
        </tr>; })}
        {visibleTasks.length === 0 && <tr>
          <td colSpan={5} className="task-table-no-results">
            {search ? 'No tasks match your search.' : 'No tasks yet. Create one to get started.'}
          </td>
        </tr>}
      </tbody>
    </DataTable>
  </section>;
}

export default function TasksView({ workspaceId, channelId, members, createSignal, onCreateHandled, requestedBoardId, requestedTaskId, embedded = false, projectRuns, onShare }: Props) {
  const queryClient = useQueryClient();
  const [boardId, setBoardId] = useState('');
  const [boardName, setBoardName] = useState('');
  const [creatingBoard, setCreatingBoard] = useState(false);
  // A create request opens the form once; clearing it keeps later visits from reopening it.
  useEffect(() => { if (createSignal) { setCreatingBoard(true); onCreateHandled?.(); } }, [createSignal]);
  const [taskModal, setTaskModal] = useState<TeamTask | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TeamTask['status']>('todo');
  const [priority, setPriority] = useState(2);
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [view, setView] = useState<'board' | 'table' | 'calendar'>('board');
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [error, setError] = useState('');
  const openedTask = useRef('');
  const openedBoard = useRef('');
  const boards = useQuery({ queryKey: ['boards', workspaceId, channelId], queryFn: () => api<TaskBoard[]>(`/workspaces/${workspaceId}/collab/boards?channel=${channelId}`) });
  useEffect(() => { if (boards.data?.length && !boards.data.some((board) => board.id === boardId)) setBoardId(boards.data.find((board) => board.id === requestedBoardId)?.id ?? boards.data[0].id); }, [boards.data, boardId, requestedBoardId]);
  useEffect(() => { if (requestedBoardId && openedBoard.current !== requestedBoardId && boards.data?.some((board) => board.id === requestedBoardId)) { openedBoard.current = requestedBoardId; setBoardId(requestedBoardId); } }, [requestedBoardId, boards.data]);
  const board = useQuery({ queryKey: ['board', workspaceId, boardId], queryFn: () => api<TaskBoard & { tasks: TeamTask[] }>(`/workspaces/${workspaceId}/collab/boards/${boardId}`), enabled: Boolean(boardId), refetchInterval: embedded ? 3000 : false });
  const tasks = board.data?.tasks ?? [];
  const completed = tasks.filter((task) => task.status === 'done').length;

  async function createBoard(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try { const result = await post<TaskBoard>(`/workspaces/${workspaceId}/collab/boards`, { channel_id: channelId, name: boardName }); queryClient.setQueryData<TaskBoard[]>(['boards', workspaceId, channelId], (current) => [...(current ?? []), result]); setBoardId(result.id); setBoardName(''); setCreatingBoard(false); void queryClient.invalidateQueries({ queryKey: ['boards', workspaceId, channelId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create board.'); }
  }

  function openTask(task: TeamTask | 'new', initialStatus: TeamTask['status'] = 'todo') {
    setTaskModal(task); setTitle(task === 'new' ? '' : task.title); setDescription(task === 'new' ? '' : task.description); setStatus(task === 'new' ? initialStatus : task.status); setPriority(task === 'new' ? 2 : task.priority); setAssignee(task === 'new' ? '' : task.assignee_id ?? ''); setDue(task === 'new' || !task.due_at ? '' : new Date(task.due_at).toISOString().slice(0, 10)); setError('');
  }
  useEffect(() => {
    if (!requestedTaskId || !board.data || openedTask.current === requestedTaskId) return;
    const task = board.data.tasks.find((item) => item.id === requestedTaskId);
    if (task) { openedTask.current = requestedTaskId; openTask(task); }
  }, [board.data, requestedTaskId]);

  async function share(kind: 'task' | 'board', item: { id: string; title?: string; name?: string }) {
    const url = `/w/${workspaceId}/${channelId}?view=tasks&board=${boardId}${kind === 'task' ? `&task=${item.id}` : ''}`;
    try { await onShare?.(kind, item.title ?? item.name ?? 'Untitled', url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not share in chat.'); }
  }

  async function saveTask(event: React.FormEvent) {
    event.preventDefault(); setError('');
    const input = { title, description, status, priority, assignee_id: assignee || null, due_at: due ? new Date(`${due}T12:00:00`).getTime() : null };
    try {
      if (taskModal === 'new') await post(`/workspaces/${workspaceId}/collab/boards/${boardId}/tasks`, input);
      else if (taskModal) await api(`/workspaces/${workspaceId}/collab/tasks/${taskModal.id}`, { method: 'PATCH', body: JSON.stringify(input) });
      setTaskModal(null); void queryClient.invalidateQueries({ queryKey: ['board', workspaceId, boardId] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save task.'); }
  }

  async function moveTask(taskId: string, nextStatus: TeamTask['status']) {
    try { await api(`/workspaces/${workspaceId}/collab/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) }); void queryClient.invalidateQueries({ queryKey: ['board', workspaceId, boardId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not move task.'); }
  }

  const calendarDays = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); return day; });
  }, [month]);

  return <div className={`collab-view ${embedded ? 'project-board' : ''}`}>
    <div className="collab-header">
      <div><h2>{embedded ? 'Work' : 'Tasks'}</h2></div>
      <div className="collab-actions">
        {boardId && <>
          {!embedded && <div className="view-tabs">
            <button type="button" aria-pressed={view === 'board'} className={`view-tab ${view === 'board' ? 'selected' : ''}`} onClick={() => setView('board')}><Squares2X2Icon /> Board</button>
            <button type="button" aria-pressed={view === 'table'} className={`view-tab ${view === 'table' ? 'selected' : ''}`} onClick={() => setView('table')}><TableCellsIcon /> Table</button>
            <button type="button" aria-pressed={view === 'calendar'} className={`view-tab ${view === 'calendar' ? 'selected' : ''}`} onClick={() => setView('calendar')}><CalendarDaysIcon /> Calendar</button>
          </div>}
          <button type="button" className="button primary" onClick={() => openTask('new')}><PlusIcon /> New task</button>
        </>}
      </div>
    </div>
    {error && <p className="error-banner collab-error">{error}</p>}
    {boards.isPaused && !boards.data ? <LoadNotice title="You are offline" detail="Reconnect to load the boards in this channel." onRetry={() => void boards.refetch()} /> : boards.isPending ? <div className="empty-state">Loading boards…</div> : boards.isError && !boards.data ? <LoadNotice title="Boards could not load" detail="The tasks are still here. Try loading this channel again." onRetry={() => void boards.refetch()} /> : boards.data?.length ? <>
      <div className="board-switcher">
        <label className="sr-only" htmlFor="board-select">Choose task board</label>
        <select id="board-select" name="board" value={boardId} onChange={(event) => setBoardId(event.target.value)}>
          {boards.data.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" onClick={() => setCreatingBoard(true)}><PlusIcon /> New board</button>
        {board.data && onShare && <button type="button" onClick={() => void share('board', board.data!)}><ShareIcon /> Share in chat</button>}
        <span className="board-progress">{completed} of {tasks.length} complete</span>
      </div>
      {board.isPaused && !board.data ? <LoadNotice title="You are offline" detail="Reconnect to load this board." onRetry={() => void board.refetch()} /> : board.isPending ? <div className="empty-state">Loading board…</div> : board.isError && !board.data ? <LoadNotice title="Board could not load" detail="Try opening its tasks again." onRetry={() => void board.refetch()} /> : view === 'board' ? <div className="kanban-scroll">
        <div className="kanban-board" style={{gridTemplateColumns:`repeat(${tasks.some(task => task.status === 'blocked') ? 5 : 4}, minmax(190px, 1fr))`}}>
          {statuses.filter(column => column.id !== 'blocked' || tasks.some(task => task.status === 'blocked')).map((column) => <section className={`kanban-column status-${column.id}`} key={column.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/task-id'); if (id) void moveTask(id, column.id); }}>
            <div className="kanban-title">
              <h3>{column.name}</h3>
              <span>{tasks.filter((task) => task.status === column.id).length}</span>
            </div>
            <div className="kanban-items">
              {tasks.filter((task) => task.status === column.id).map((task) => <TaskCard key={task.id} task={task} members={members} linkedRun={projectRuns?.find((run) => run.task_id === task.id && !['cancelled', 'integrated', 'failed'].includes(run.status))} onOpen={() => openTask(task)} />)}
            </div>
            <button type="button" className="add-task-inline" onClick={() => openTask('new', column.id)}><PlusIcon /> Add task</button>
          </section>)}
        </div>
      </div> : view === 'table' ? <TaskTable tasks={tasks} members={members} onOpen={openTask} /> : <div className="calendar-wrap">
        <div className="calendar-header">
          <h3>{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(month)}</h3>
          <div>
            <button type="button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
              <ChevronLeftIcon />
            </button>
            <button type="button" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</button>
            <button type="button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
              <ChevronRightIcon />
            </button>
          </div>
        </div>
        <div className="calendar-grid">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name) => <div className="weekday" key={name}>{name}</div>)}
          {calendarDays.map((day) => <div className={`calendar-day ${day.getMonth() !== month.getMonth() ? 'outside' : ''}`} key={day.toISOString()}>
            <span>{day.getDate()}</span>
            {tasks.filter((task) => task.due_at && new Date(task.due_at).toDateString() === day.toDateString()).map((task) => <button type="button" key={task.id} className={`calendar-task status-${task.status}`} onClick={() => openTask(task)}>
              {task.title}
            </button>)}
          </div>)}
        </div>
      </div>}
    </> : <div className="collab-empty">
      <Squares2X2Icon />
      <h3>Plan work in this channel</h3>
      <p>Create a board to organize tasks, owners, and due dates.</p>
      <button type="button" className="button primary" onClick={() => setCreatingBoard(true)}><PlusIcon /> Create a board</button>
    </div>}

    {creatingBoard && <Modal title="New task board" onClose={() => setCreatingBoard(false)}><form onSubmit={createBoard}><div className="modal-form"><label htmlFor="board-name">Board name</label><input id="board-name" name="board-name" value={boardName} placeholder="Design requests" onChange={(event) => setBoardName(event.target.value)} required />{error && <p className="error-banner" role="alert">{error}</p>}<div className="modal-actions"><button type="submit" className="button primary">Create board</button></div></div></form></Modal>}

    {taskModal && <Modal title={taskModal === 'new' ? 'New task' : 'Task details'} onClose={() => setTaskModal(null)}>
      <form onSubmit={saveTask}>
        <div className="modal-form task-form">
          <label htmlFor="task-title">Title</label>
          <input id="task-title" name="task-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
          <label htmlFor="task-description">Description</label>
          <textarea id="task-description" name="task-description" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
          <div className="form-grid">
            <div>
              <label htmlFor="task-status">Status</label>
              <select id="task-status" name="task-status" value={status} onChange={(event) => setStatus(event.target.value as TeamTask['status'])}>
                {statuses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="task-priority">Priority</label>
              <select id="task-priority" name="task-priority" value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
                <option value={1}>Low</option>
                <option value={2}>Normal</option>
                <option value={3}>High</option>
              </select>
            </div>
            <div>
              <label htmlFor="task-assignee">Assignee</label>
              <select id="task-assignee" name="task-assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                <option value="">Unassigned</option>
                {members.map((member) => <option key={member.account_id} value={member.account_id}>{member.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="task-due">Due date</label>
              <input type="date" id="task-due" name="task-due" value={due} onChange={(event) => setDue(event.target.value)} />
            </div>
          </div>
          {taskModal !== 'new' && <TaskReferences workspaceId={workspaceId} taskId={taskModal.id} members={members} onOpen={() => setTaskModal(null)} />}
          {taskModal !== 'new' && projectRuns?.filter(run=>run.task_id===taskModal.id).map(run=><a key={run.id} className="button secondary" href={`#project-run-${run.id}`} onClick={()=>setTaskModal(null)}>View work: {run.title}</a>)}
          {error && <p className="error-banner">{error}</p>}
          <div className="modal-actions">
            {taskModal !== 'new' && onShare && <button type="button" className="button secondary" onClick={() => void share('task', taskModal)}><ShareIcon /> Share in chat</button>}
            <button type="button" className="button secondary" onClick={() => setTaskModal(null)}>Cancel</button>
            <button type="submit" className="button primary">Save task</button>
          </div>
        </div>
      </form>
    </Modal>}

  </div>;
}
