import { defineNuxtRouteMiddleware, navigateTo } from '#imports'
import { useUserSession } from '../composables/useUserSession'

/** Sends signed-out visitors to `/login`, which returns them here after signing in. */
export default defineNuxtRouteMiddleware((to) => {
  if (useUserSession().loggedIn.value) return
  return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
})
