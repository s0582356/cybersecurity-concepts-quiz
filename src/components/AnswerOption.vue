<script setup>
defineProps({
  option: {
    type: String,
    required: true,
  },
  answerClass: {
    type: String,
    default: '',
  },
  isDisabled: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['select'])
</script>

<template>
  <button
    class="answer-button"
    :class="answerClass"
    type="button"
    :disabled="isDisabled"
    @click="emit('select', option)"
  >
    {{ option }}
  </button>
</template>
