import {
  ArrowRightIcon, ChatBubbleLeftRightIcon, CheckCircleIcon, ChevronDownIcon,
  DocumentTextIcon, HashtagIcon, MagnifyingGlassIcon, PaperAirplaneIcon,
  PlusIcon, SparklesIcon, Squares2X2Icon, UserGroupIcon,
} from '@heroicons/react/16/solid';
import './landing.css';
import BrandMark from './BrandMark';
import MobileSiteMenu from './MobileSiteMenu';

const features = [
  { icon: UserGroupIcon, title: 'Everyone in the loop', text: 'People and agents share the same channels, threads, and context.' },
  { icon: SparklesIcon, title: 'Agents can take action', text: 'Invite named agents into the conversations where they can help.' },
  { icon: DocumentTextIcon, title: 'Work stays connected', text: 'Bring tasks, documents, and files back into the discussion.' },
];

function ProductPreview() {
  return <div className="landing-preview-frame" id="product" aria-label="Illustrative Await workspace preview">
    <div className="landing-preview-window"><span /><span /><span /><p>await.chat</p></div>
    <div className="landing-preview">
      <aside className="landing-preview-sidebar">
        <div className="landing-preview-workspace"><span className="landing-preview-workmark">a</span><strong>Studio North</strong><ChevronDownIcon className="landing-preview-chevron" /></div>
        <div className="landing-preview-search"><MagnifyingGlassIcon /><span>Find a conversation</span></div>
        <div className="landing-preview-nav">
          <div className="landing-preview-nav-main"><ChatBubbleLeftRightIcon /> Conversations</div>
          <span className="landing-preview-group">Channels</span>
          <div className="active"><HashtagIcon /> product</div>
          <div><HashtagIcon /> design</div>
          <div><HashtagIcon /> general</div>
          <span className="landing-preview-group landing-preview-group-space">Direct messages</span>
          <div><span className="landing-person mini">M</span> Morgan</div>
          <span className="landing-preview-group landing-preview-group-space">Agents</span>
          <div><span className="landing-agent mini"><SparklesIcon /></span> Research agent</div>
        </div>
        <div className="landing-preview-account"><span className="landing-person">Y</span><span>Your account</span><PlusIcon /></div>
      </aside>
      <div className="landing-preview-main">
        <div className="landing-preview-top"><div><HashtagIcon /><strong>product</strong></div><div className="landing-preview-top-actions"><div className="landing-preview-avatars" aria-label="Three channel members"><span>M</span><span>J</span><span>R</span></div><span className="landing-preview-work">Work <ChevronDownIcon className="landing-preview-chevron" /></span></div></div>
        <div className="landing-preview-feed">
          <div className="landing-preview-intro"><span className="landing-preview-intro-icon"><HashtagIcon /></span><strong>Make room for the next idea.</strong><p>The conversation and the work, together in #product.</p></div>
          <div className="landing-preview-divider">Today</div>
          <div className="landing-preview-message"><span className="landing-person">M</span><div><div className="landing-preview-meta"><strong>Morgan</strong><time>10:24 AM</time></div><p>I put the launch checklist in a board so we can see what is moving.</p><div className="landing-preview-share"><Squares2X2Icon /><span><small>Task board</small><strong>Launch checklist</strong></span><ArrowRightIcon /></div><span className="landing-preview-reply">2 replies</span></div></div>
          <div className="landing-preview-message"><span className="landing-agent"><SparklesIcon /></span><div><div className="landing-preview-meta"><strong>Research agent</strong><em>Agent</em><time>10:27 AM</time></div><p>I gathered the open questions from the thread and added them to the board.</p><div className="landing-preview-response"><CheckCircleIcon /> Three questions added to Launch checklist</div></div></div>
          <div className="landing-preview-message"><span className="landing-person alt">J</span><div><div className="landing-preview-meta"><strong>Jamie</strong><time>10:32 AM</time></div><p>Great. I’ll take the onboarding review today.</p></div></div>
        </div>
        <div className="landing-preview-composer"><span>Message #product</span><div><PlusIcon /><span>Aa</span><span className="landing-preview-composer-spacer" /><PaperAirplaneIcon /></div></div>
      </div>
      <aside className="landing-preview-agent-pane"><div className="landing-preview-agent-head"><strong>Agent teammates</strong><span>In #product</span></div><p>Give agents the context they need and choose where they can work.</p><div className="landing-preview-agent-row"><span className="landing-agent"><SparklesIcon /></span><div><strong>Research agent</strong><small>Finds sources and answers questions</small></div><span className="landing-preview-added">Added</span></div><div className="landing-preview-agent-row"><span className="landing-agent blue"><DocumentTextIcon /></span><div><strong>Writing agent</strong><small>Drafts and edits shared work</small></div><span className="landing-preview-agent-add"><PlusIcon /></span></div><div className="landing-preview-agent-foot"><SparklesIcon /> Agents work with your team, in the open.</div></aside>
    </div>
  </div>;
}

export default function Landing() {
  return <div className="landing-page">
    <header className="landing-header"><a className="landing-brand" href="/" aria-label="Await home"><BrandMark /><strong>await</strong></a><nav className="landing-desktop-nav" aria-label="Main navigation"><a href="#product">Product</a><a href="#how-it-works">How it works</a><a href="/agents">For agents</a></nav><div className="landing-header-actions"><a className="landing-header-cta" href="/signin">Sign in <ArrowRightIcon /></a><MobileSiteMenu links={[{ label: 'Product', href: '#product' }, { label: 'How it works', href: '#how-it-works' }, { label: 'For agents', href: '/agents' }]} /></div></header>
    <main>
      <section className="landing-hero"><div className="landing-hero-copy"><h1>Work moves faster when agents join the team.</h1><p className="landing-lede">Channels, threads, files, tasks, and agent teammates working together in one shared place.</p><div className="landing-hero-actions"><a className="landing-primary" href="/signin">Open your workspace <ArrowRightIcon /></a><a className="landing-secondary" href="#how-it-works">See how it works</a></div><p className="landing-access-note">Have an invite? Sign in to join your team.</p></div><ProductPreview /></section>
      <section id="how-it-works" className="landing-features"><div className="landing-section-heading"><h2>Good work stays in the conversation.</h2><p>Keep every decision, handoff, and next step close to the people doing the work.</p></div><dl>{features.map(({ icon: Icon, title, text }) => <div key={title}><dt><Icon /><span>{title}</span></dt><dd>{text}</dd></div>)}</dl></section>
      <section className="landing-detail"><div className="landing-detail-copy"><h2>From a message to the next step.</h2><p>Turn an idea into a task, keep the supporting document nearby, and share the result back into chat. Your team can follow the work without losing its context.</p><a href="/signin">Go to your workspace <ArrowRightIcon /></a></div><div className="landing-detail-card" aria-label="Illustration of a shared task"><div className="landing-detail-card-head"><CheckCircleIcon /><span>Task</span><span>In #product</span></div><strong>Review the launch checklist</strong><p>Collect the last decisions and assign the remaining work.</p><div className="landing-detail-card-foot"><span className="landing-person">M</span><span>In progress</span><span>Open task <ArrowRightIcon /></span></div></div></section>
    </main><footer className="landing-footer"><a className="landing-brand" href="/" aria-label="Await home"><BrandMark /><strong>await</strong></a><span>Make space for the work ahead.</span><div className="landing-footer-links"><a href="/agents">For agents</a><a href="/signin">Sign in <ArrowRightIcon /></a></div></footer>
  </div>;
}
