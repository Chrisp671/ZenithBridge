import { Notice, SuggestModal, WorkspaceLeaf } from "obsidian";
import type ClaudeMcpPlugin from "main";
import {
	TerminalProfile,
	TerminalSessionState,
	BUILTIN_CLAUDE_PROFILE_ID,
	getTerminalProfileById,
	getTerminalProfiles,
} from "./profiles";
import { TERMINAL_VIEW_TYPE } from "./terminal-view";

class TerminalProfileSuggestModal extends SuggestModal<TerminalProfile> {
	constructor(
		private plugin: ClaudeMcpPlugin,
		private profiles: TerminalProfile[],
		private onChoose: (profile: TerminalProfile) => void
	) {
		super(plugin.app);
		this.setPlaceholder("Choose a terminal profile");
	}

	getSuggestions(query: string): TerminalProfile[] {
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) {
			return this.profiles;
		}

		return this.profiles.filter((profile) => {
			return (
				profile.name.toLowerCase().includes(normalizedQuery) ||
				profile.launchCommand.toLowerCase().includes(normalizedQuery)
			);
		});
	}

	renderSuggestion(profile: TerminalProfile, el: HTMLElement): void {
		el.createEl("div", { text: profile.name });
		el.createEl("small", {
			text: profile.launchCommand || "Shell only",
		});
	}

	onChooseSuggestion(profile: TerminalProfile): void {
		this.onChoose(profile);
	}
}

export class TerminalManager {
	private sessionLeaves = new Map<string, WorkspaceLeaf>();
	private sessionStates = new Map<string, TerminalSessionState>();
	private lastActiveSessionId: string | null = null;

	constructor(private plugin: ClaudeMcpPlugin) {}

	getProfiles(): TerminalProfile[] {
		return getTerminalProfiles(this.plugin.settings.terminalProfiles);
	}

	getDefaultProfile(): TerminalProfile {
		return (
			this.getProfileById(this.plugin.settings.defaultTerminalProfileId) ||
			this.getProfileById(BUILTIN_CLAUDE_PROFILE_ID) ||
			this.getProfiles()[0]
		);
	}

	getProfileById(profileId: string): TerminalProfile | undefined {
		return getTerminalProfileById(
			this.plugin.settings.terminalProfiles,
			profileId
		);
	}

	getOpenTerminalCount(): number {
		return this.plugin.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)
			.length;
	}

	async focusOrCreateTerminal(): Promise<void> {
		const existingLeaf = this.getPreferredLeaf();
		if (existingLeaf) {
			this.focusLeaf(existingLeaf);
			return;
		}

		await this.openDefaultTerminal();
	}

	async openDefaultTerminal(): Promise<void> {
		await this.openTerminalForProfile(this.getDefaultProfile().id);
	}

	openTerminalPicker(): void {
		const profiles = this.getProfiles();
		if (profiles.length === 0) {
			new Notice("No terminal profiles configured.");
			return;
		}

		new TerminalProfileSuggestModal(this.plugin, profiles, (profile) => {
			void this.openTerminalForProfile(profile.id);
		}).open();
	}

	async openTerminalForProfile(profileId: string): Promise<void> {
		const profile = this.getProfileById(profileId);
		if (!profile) {
			new Notice("That terminal profile no longer exists.");
			return;
		}

		const maxSessions = Math.max(
			1,
			Math.min(this.plugin.settings.maxTerminalSessions || 4, 12)
		);
		if (this.getOpenTerminalCount() >= maxSessions) {
			new Notice(
				`Maximum ${maxSessions} terminal sessions reached. Close one to open another.`
			);
			return;
		}

		const state = this.createSessionState(profile);
		const leaf = this.plugin.app.workspace.getLeaf("split");
		await leaf.setViewState({
			type: TERMINAL_VIEW_TYPE,
			active: true,
			state,
		});

		this.registerSessionLeaf(state, leaf);
		this.focusLeaf(leaf);
	}

	registerSessionLeaf(
		sessionState: TerminalSessionState,
		leaf: WorkspaceLeaf
	): void {
		this.sessionLeaves.set(sessionState.sessionId, leaf);
		this.sessionStates.set(sessionState.sessionId, sessionState);
	}

	unregisterSession(sessionId: string): void {
		this.sessionLeaves.delete(sessionId);
		this.sessionStates.delete(sessionId);
		if (this.lastActiveSessionId === sessionId) {
			this.lastActiveSessionId = null;
		}
	}

	markSessionActive(sessionId: string): void {
		if (!this.sessionLeaves.has(sessionId)) {
			return;
		}

		this.lastActiveSessionId = sessionId;
	}

	closeAllTerminalLeaves(): void {
		this.sessionLeaves.clear();
		this.sessionStates.clear();
		this.lastActiveSessionId = null;
		this.plugin.app.workspace.detachLeavesOfType(TERMINAL_VIEW_TYPE);
	}

	private createSessionState(profile: TerminalProfile): TerminalSessionState {
		const ordinal = this.getNextOrdinal(profile.id);
		return {
			sessionId: `${profile.id}-${Date.now().toString(36)}-${Math.random()
				.toString(36)
				.slice(2, 8)}`,
			profileId: profile.id,
			displayName: `${profile.name} ${ordinal}`,
			ordinal,
		};
	}

	private getNextOrdinal(profileId: string): number {
		let highestOrdinal = 0;
		for (const sessionState of this.sessionStates.values()) {
			if (
				sessionState.profileId === profileId &&
				sessionState.ordinal > highestOrdinal
			) {
				highestOrdinal = sessionState.ordinal;
			}
		}

		return highestOrdinal + 1;
	}

	private getPreferredLeaf(): WorkspaceLeaf | null {
		if (this.lastActiveSessionId) {
			const lastActiveLeaf =
				this.sessionLeaves.get(this.lastActiveSessionId) || null;
			if (lastActiveLeaf) {
				return lastActiveLeaf;
			}
		}

		const leaves =
			this.plugin.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
		return leaves[0] || null;
	}

	private focusLeaf(leaf: WorkspaceLeaf): void {
		this.plugin.app.workspace.revealLeaf(leaf);
		window.setTimeout(() => {
			const view = leaf.view as { focusTerminal?: () => void };
			if (typeof view.focusTerminal === "function") {
				view.focusTerminal();
			}
		}, 50);
	}
}
