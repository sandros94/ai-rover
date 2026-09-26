<script setup lang="ts">
const { data, error } = await useFetch('/api/community')
const members = computed(() => data.value?.members ?? [])

useSeoMeta({ title: 'Community · Jev Rover' })
</script>

<template>
  <UContainer class="space-y-4 py-4">
    <SiteHeader />
    <h1 class="text-base font-semibold">Community</h1>
    <UAlert
      v-if="error"
      color="neutral"
      variant="subtle"
      title="The community cannot be shown."
      description="No mission is active, or the tallies did not load."
    />
    <p v-else-if="members.length === 0" data-test="members-empty" class="text-sm text-muted">
      Nobody has submitted a destination yet.
    </p>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-muted">
          <tr>
            <th class="py-2 pr-3 font-medium">Member</th>
            <th class="py-2 pr-3 text-right font-medium">Distance driven</th>
            <th class="py-2 pr-3 text-right font-medium">Segments won</th>
            <th class="py-2 pr-3 text-right font-medium">LGTMs received</th>
            <th class="py-2 text-right font-medium">Failures</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="member in members"
            :key="member.user.id"
            data-test="member"
            class="border-t border-default"
          >
            <td class="py-2 pr-3">
              <span class="flex min-w-0 items-center gap-2">
                <UAvatar
                  :src="member.user.avatarUrl ?? undefined"
                  :alt="member.user.displayName"
                  size="xs"
                />
                <span class="truncate" data-test="member-name">{{ member.user.displayName }}</span>
              </span>
            </td>
            <td class="py-2 pr-3 text-right tabular-nums" data-test="member-distance">
              {{ Math.round(member.distanceM) }} m
            </td>
            <td class="py-2 pr-3 text-right tabular-nums" data-test="member-won">
              {{ member.won }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums" data-test="member-lgtms">
              {{ member.lgtmsReceived }}
            </td>
            <td class="py-2 text-right tabular-nums" data-test="member-failures">
              {{ member.failures }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </UContainer>
</template>
