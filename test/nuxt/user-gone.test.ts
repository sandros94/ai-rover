import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import type { Component } from 'vue'
import { defineComponent, h } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useState } from '#imports'
import { UApp } from '#components'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { MissionStateJson } from '~/composables/useMissionState'
import { usePickSubmit } from '~/composables/usePickSubmit'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import RoundPanel from '~/components/dashboard/RoundPanel.vue'
// @ts-ignore -- tsgolint (oxlint) cannot resolve .vue modules; `pnpm typecheck` checks them.
import NotMovingFlag from '~/components/dashboard/NotMovingFlag.vue'

const MESSAGE = 'Your account no longer exists; sign in again.'
const GONE = () =>
  new Response(JSON.stringify({ status: 401, message: MESSAGE, code: 'USER_GONE' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })

const ADA = { id: '0192f000-0000-7000-8000-00000000000a', displayName: 'Ada', avatarUrl: null }
const SUBMISSION_ID = '0192f000-0000-7000-8000-0000000000e1'
const SEGMENT_ID = '0192f000-0000-7000-8000-0000000000e2'

/** Every session read, so a test sees the page ask again after the server cleared it. */
let sessionReads = 0
registerEndpoint('/api/_auth/session', () => {
  sessionReads++
  return {}
})
registerEndpoint(`/api/mission/submissions/${SUBMISSION_ID}/like`, { method: 'PUT', handler: GONE })
registerEndpoint(`/api/mission/segments/${SEGMENT_ID}/flag`, { method: 'PUT', handler: GONE })
registerEndpoint(`/api/mission/segments/${SEGMENT_ID}/flag`, {
  method: 'GET',
  handler: () => ({ mine: false }),
})
registerEndpoint('/api/mission/likes', () => ({ roundId: 'r1', submissionIds: [] }))
registerEndpoint('/api/mission/submissions', { method: 'POST', handler: GONE })

function signIn() {
  useState('rover-user-session').value = {
    user: { id: ADA.id, displayName: 'Ada', providers: ['github'] },
    loggedInAt: 1,
  }
}

function mount(component: Component, props: Record<string, unknown>) {
  return mountSuspended(
    defineComponent({ render: () => h(UApp, null, { default: () => h(component, props) }) }),
  )
}

afterEach(() => {
  useState('rover-user-session').value = {}
  sessionReads = 0
  vi.restoreAllMocks()
})

const state = (): MissionStateJson =>
  ({
    now: '2026-09-26T10:00:00.000Z',
    mission: {
      id: 'm1',
      status: 'active',
      worldHash: 'w',
      solsEpoch: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      rules: structuredClone(DEFAULT_MISSION_RULES),
    },
    currentStop: {
      id: 's0',
      index: 0,
      x: 0,
      y: 0,
      headingRad: 0,
      manifestKey: 'k',
      revealedKey: 'r',
    },
    round: {
      id: 'r1',
      opensAt: '2026-09-26T09:00:00.000Z',
      fromStopId: 's0',
      anchor: { x: 0, y: 0 },
      closesAt: null,
      submissions: [
        {
          id: SUBMISSION_ID,
          goal: { x: 60, y: 80 },
          createdAt: '2026-09-26T09:00:00.000Z',
          likes: 1,
          submitter: { ...ADA, id: 'someone-else' },
          deferred: false,
          judgment: {
            feasible: 0.9,
            verdict: 'accept',
            risk: 0.5,
            distanceWeight: 1,
            timeWeight: 1,
          },
          summary: {
            rover: {},
            mission_rules: 'rules',
            destination: { straight_line_m: 100, straight_line_label: 'medium', bearing: 'north' },
            route: { reached: false },
          },
        },
      ],
    },
    segment: null,
  }) as unknown as MissionStateJson

describe('a session whose account is gone', () => {
  it('shows the message on an LGTM and reads the session again', async () => {
    signIn()
    const wrapper = await mount(RoundPanel, { state: state() })
    await flushPromises()
    await wrapper.find('[data-test=like]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-test=like-error]').exists()).toBe(true))
    expect(wrapper.find('[data-test=like-error]').text()).toBe(MESSAGE)
    expect(sessionReads).toBeGreaterThan(0)
    expect(useState('rover-user-session').value).toEqual({})
    // Signed out now: the card asks to sign in.
    expect(wrapper.find('[data-test=like]').attributes('href')).toBe('/login')
  })

  it('shows the message on a not-moving flag and reads the session again', async () => {
    signIn()
    const wrapper = await mount(NotMovingFlag, {
      segmentId: SEGMENT_ID,
      flags: { count: 0, quorum: 2 },
      signedIn: true,
    })
    await flushPromises()
    await wrapper.find('[data-test=flag]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-test=flag-error]').exists()).toBe(true))
    expect(wrapper.find('[data-test=flag-error]').text()).toBe(MESSAGE)
    expect(useState('rover-user-session').value).toEqual({})
  })

  it('keeps the message as the refusal of a submission and reads the session again', async () => {
    signIn()
    let flow!: ReturnType<typeof usePickSubmit>
    await mountSuspended(
      defineComponent({
        setup() {
          const preview = {
            request: vi.fn<() => void>(),
            requestNow: vi.fn<() => void>(),
            clear: vi.fn<() => void>(),
          }
          flow = usePickSubmit(preview as never, {
            highlight: () => null,
            onSubmitted: vi.fn<() => void>(),
            onStale: vi.fn<() => void>(),
          })
          return () => h('div')
        },
      }),
    )
    flow.onPick({ x: 10, y: 20 })
    await flow.confirm()
    expect(flow.refusal.value).toEqual({ reason: 'USER_GONE', message: MESSAGE })
    expect(sessionReads).toBeGreaterThan(0)
    expect(useState('rover-user-session').value).toEqual({})
  })
})
