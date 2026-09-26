import { create } from 'zustand'

export type LaunchPage = 'projects' | 'create' | 'gallery'
export type ProjectFilter = 'all' | 'recent' | 'imported'

interface LaunchNavigationState {
  page: LaunchPage
  filter: ProjectFilter
  showProjects(filter?: ProjectFilter): void
  showCreate(): void
  showGallery(): void
}

/** The Coding Space left View and main launchpad share only navigation state; drafts stay in the launchpad. */
export const useLaunchNavigation = create<LaunchNavigationState>((set) => ({
  page: 'projects',
  filter: 'all',
  showProjects: (filter = 'all') => set({ page: 'projects', filter }),
  showCreate: () => set({ page: 'create' }),
  showGallery: () => set({ page: 'gallery' }),
}))
