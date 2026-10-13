import { useEffect, useRef, type ReactNode } from 'react';
import { CheckIcon, ComputerDesktopIcon, MoonIcon, SunIcon, SwatchIcon, UserCircleIcon, UserGroupIcon, XMarkIcon } from '@heroicons/react/16/solid';
import Modal from './Modal';
import { useTheme } from './ThemeProvider';
import { THEME_PALETTES, type ThemeMode } from './theme';

export type SettingsSection = 'appearance' | 'team' | 'account';
const sections = [
  { id: 'appearance' as const, label: 'Appearance', icon: SwatchIcon },
  { id: 'team' as const, label: 'Members & agents', icon: UserGroupIcon },
  { id: 'account' as const, label: 'Your account', icon: UserCircleIcon },
];
const modes: { value: ThemeMode; label: string; icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: ComputerDesktopIcon },
];

function AppearanceSettings() {
  const { preference, resolvedMode, updateTheme } = useTheme();
  return <div className="appearance-settings">
    <div className="settings-section-heading"><h3 id="settings-appearance-heading">Appearance</h3></div>
    <fieldset className="appearance-fieldset"><legend>Theme</legend><p>Choose a look, or follow your device.</p><div className="appearance-modes">{modes.map(({ value, label, icon: Icon }) => <label className={`appearance-mode-card mode-${value}`} key={value}>
      <input type="radio" name="theme-mode" value={value} checked={preference.mode === value} onChange={() => updateTheme({ mode: value })} />
      <span className="mode-preview theme-sample" data-accent={preference.accent} data-theme={value === 'system' ? resolvedMode : value} aria-hidden="true"><span className="mode-preview-sidebar"><i /><i /><i /></span><span className="mode-preview-chat"><i /><i /><i /></span><span className="mode-preview-selected"><CheckIcon /></span></span>
      <span className="mode-label"><Icon />{label}</span>
    </label>)}</div></fieldset>
    <fieldset className="appearance-fieldset"><legend>Palette</legend><p>Six looks, each with a light and dark edition.</p><div className="appearance-palettes">{THEME_PALETTES.map(({ value, label, description }) => <label className="appearance-palette" key={value}>
      <input type="radio" name="theme-accent" value={value} aria-label={label} checked={preference.accent === value} onChange={() => updateTheme({ accent: value })} />
      <span className="theme-sample" data-accent={value} data-theme={resolvedMode} aria-hidden="true"><span className="palette-mini-rail"><i /><i /><i /></span><span className="palette-mini-sidebar"><i /><i /><i /><i /></span><span className="palette-mini-chat"><b /><span><i /><i /></span><span><i /><i /></span><em /></span></span>
      <span className="palette-label"><strong>{label}</strong><span className="palette-selected" aria-hidden="true"><CheckIcon /></span></span><span className="palette-description">{description}</span>
    </label>)}</div></fieldset>
    <p className="settings-saved-note">Changes apply instantly and are saved in this browser.</p>
  </div>;
}

export default function SettingsDialog({ section, onSectionChange, workspaceName, pendingCount, children, onClose }: {
  section: SettingsSection; onSectionChange: (section: SettingsSection) => void; workspaceName: string;
  pendingCount: number; children?: ReactNode; onClose: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { content.current?.scrollTo({ top: 0 }); }, [section]);
  return <Modal title="Settings" className="settings-dialog" onClose={onClose} hideHeader>
    <button type="button" className="icon-button settings-close" aria-label="Close settings" onClick={onClose}><XMarkIcon /></button>
    <div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections">
      <p className="settings-workspace">{workspaceName}</p>
      {sections.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => onSectionChange(id)}><Icon /><span>{label}</span>{id === 'team' && pendingCount > 0 && <b className="settings-pending-count" aria-label={`${pendingCount} agent posts awaiting review`}>{pendingCount}</b>}</button>)}
    </nav><div ref={content} className="settings-content" key={section}>{section === 'appearance' ? <AppearanceSettings /> : children}</div></div>
  </Modal>;
}
